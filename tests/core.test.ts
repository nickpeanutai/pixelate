import { afterEach, describe, expect, it, vi } from "vitest";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { createHistory, commit, redo, undo } from "@pixel-sprite/editor-core";
import {
  applyPalette,
  compositeReferenceOnChroma,
  detectPseudoPixelGrid,
  dominantPalette,
  edgeAwareDownscale,
  frameDifference,
  legacyPixelateImageData,
  pixelateAnimationFrames,
  pixelateImageData,
  prepareExternalVideoReference,
  removeChromaBackground,
  validateExternalVideoReference,
} from "@pixel-sprite/pixel-core";
import { buildManifest, frameSetDimensions } from "@pixel-sprite/export-core";
import {
  createProject,
  loadLastProject,
  migrateProject,
  stripSecrets,
  type ReferenceImageMetadata,
  type SourceImageMetadata,
  type SourceVideoMetadata,
} from "@pixel-sprite/project-schema";
import { addSourceMarker, automaticMarkerCount, createAutomaticMarkers, frameIndexAtTime, moveSourceMarker, normalizeExtractFps, normalizePlaybackFps, sourceFrameCount, timeForSourceFrame } from "../src/frame-picker";
import { canvasDisplaySize, fitCanvasZoom, zoomIn, zoomOut } from "../src/canvas-view";
import { originalFrameDrawTransform } from "../src/frame-output";
import { buildChromaPrompt, buildVideoChromaPrompt, generatePrompt, getPromptTemplate, getPromptTemplates, resolveChromaKey } from "../src/external-prompt";
import { formatStarCount, parseStarCount } from "../src/github-stars";

class TestImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height; }
}
// @ts-expect-error lightweight ImageData polyfill for deterministic algorithm tests
globalThis.ImageData = TestImageData;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("GitHub star count", () => {
  it("accepts only non-negative safe integer repository counts", () => {
    expect(parseStarCount({ stargazers_count: 0 })).toBe(0);
    expect(parseStarCount({ stargazers_count: 42 })).toBe(42);
    expect(parseStarCount({ stargazers_count: -1 })).toBeUndefined();
    expect(parseStarCount({ stargazers_count: 1.5 })).toBeUndefined();
    expect(parseStarCount({ stargazers_count: "42" })).toBeUndefined();
    expect(parseStarCount(null)).toBeUndefined();
  });

  it("uses compact formatting only for larger counts", () => {
    expect(formatStarCount(999)).toBe("999");
    expect(formatStarCount(1_000)).toBe("1K");
    expect(formatStarCount(12_500)).toBe("12.5K");
  });
});

describe("project schema v13", () => {
  it("creates local prompt drafts with stable initial templates", () => {
    const project = createProject("sprite");
    expect(project.schemaVersion).toBe(13);
    expect(project.promptWorkflow).toEqual({
      image: { templateId: "animation-ready-character-v1", userText: "", imageSize: 256 },
      video: { templateId: "seamless-in-place-v1", userText: "" },
    });
    expect(project.target).toMatchObject({ backgroundMode: "transparent", chromaKey: "magenta", fps: 1, pixelSizeMode: "detected" });
    expect("workflow" in project).toBe(false);
    expect("generation" in project).toBe(false);
  });

  it("migrates only the active legacy prompt and preserves local media metadata", () => {
    const sourceVideo: SourceVideoMetadata = { id: "video-1", name: "source.mp4", mimeType: "video/mp4", size: 10, duration: 2, width: 64, height: 64, createdAt: "now", origin: "imported" };
    const sourceImage: SourceImageMetadata = { id: "image-1", name: "source.png", mimeType: "image/png", size: 10, width: 512, height: 512, createdAt: "now", origin: "external" };
    const referenceImage: ReferenceImageMetadata = { id: "reference-1", name: "hero.png", mimeType: "image/png", size: 10, width: 64, height: 64, createdAt: "now", origin: "upload" };
    const project = migrateProject({
      schemaVersion: 8,
      mode: "animation",
      prompt: "挥剑并回到起始姿势",
      workflow: { imageMode: "api", animationMode: "external" },
      generation: { kind: "video", providerId: "legacy", modelId: "legacy-model" },
      sourceVideo,
      sourceImage,
      referenceImage,
      sourceSelection: { sourceVideoId: "video-1", sourceFps: 23.976, playheadMs: 500, markers: [{ id: "m1", timeMs: 300 }] },
    });
    expect(project.schemaVersion).toBe(13);
    expect(project.promptWorkflow.image.userText).toBe("");
    expect(project.promptWorkflow.video.userText).toBe("挥剑并回到起始姿势");
    expect(project.sourceVideo).toEqual(sourceVideo);
    expect(project.sourceImage).toEqual(sourceImage);
    expect(project.referenceImage).toEqual(referenceImage);
    expect(project.sourceSelection?.markers).toEqual([{ id: "m1", timeMs: 300 }]);
    expect(project.sourceSelection?.extractFps).toBe(1);
    expect(project.sourceSelection).toMatchObject({ rangeStartMs: 0, rangeEndMs: 2000 });
    expect(project.target.fps).toBe(1);
    expect(JSON.stringify(project)).not.toContain("legacy-model");
  });

  it("falls back from unknown template IDs while preserving valid generated drafts", () => {
    const project = migrateProject({ schemaVersion: 9, promptWorkflow: {
      image: { templateId: "missing", userText: "knight", generatedPrompt: "old image prompt", generatedAt: "now" },
      video: { templateId: "seamless-in-place-v1", userText: "walk", generatedPrompt: "old video prompt", generatedAt: "now" },
    } });
    expect(project.promptWorkflow.image.templateId).toBe("animation-ready-character-v1");
    expect(project.promptWorkflow.image.generatedPrompt).toBe("old image prompt");
    expect(project.promptWorkflow.video.generatedPrompt).toBe("old video prompt");
  });

  it("migrates legacy frames to target-sized pixel-art frames", () => {
    const project = migrateProject({ schemaVersion: 9, target: { width: 96, height: 48 }, frames: [{ id: "f", name: "frame", dataUrl: "data:image/png;base64,AA==", durationMs: 100, offsetX: 0, offsetY: 0, mirrored: false, warnings: [] }] });
    expect(project.frames[0]).toMatchObject({ width: 96, height: 48, processing: "pixel-art" });
  });

  it("moves the conflated v10 FPS to extraction and restores default playback", () => {
    const sourceVideo: SourceVideoMetadata = { id: "video-1", name: "source.mp4", mimeType: "video/mp4", size: 10, duration: 6, width: 544, height: 544, createdAt: "now", origin: "imported" };
    const project = migrateProject({
      schemaVersion: 10,
      mode: "animation",
      target: { fps: 1 },
      sourceVideo,
      sourceSelection: { sourceVideoId: sourceVideo.id, sourceFps: 24, playheadMs: 0, markers: [] },
      frames: [{ id: "f", name: "frame", dataUrl: "data:image/png;base64,AA==", durationMs: 1000, offsetX: 0, offsetY: 0, mirrored: false, warnings: [], width: 544, height: 544, processing: "original" }],
    });
    expect(project.sourceSelection?.extractFps).toBe(1);
    expect(project.target.fps).toBe(1);
    expect(project.frames[0].durationMs).toBe(1000);
  });

  it("migrates the former v11 extract FPS default from 12 to 1", () => {
    const sourceVideo: SourceVideoMetadata = { id: "video-1", name: "source.mp4", mimeType: "video/mp4", size: 10, duration: 6, width: 544, height: 544, createdAt: "now", origin: "imported" };
    const project = migrateProject({
      schemaVersion: 11,
      sourceVideo,
      sourceSelection: { sourceVideoId: sourceVideo.id, sourceFps: 24, extractFps: 12, playheadMs: 0, markers: [] },
    });
    expect(project.schemaVersion).toBe(13);
    expect(project.sourceSelection?.extractFps).toBe(1);
  });

  it("preserves a valid extraction range and removes markers outside it", () => {
    const sourceVideo: SourceVideoMetadata = { id: "video-1", name: "source.mp4", mimeType: "video/mp4", size: 10, duration: 6, width: 544, height: 544, createdAt: "now", origin: "imported" };
    const project = migrateProject({
      schemaVersion: 13,
      sourceVideo,
      sourceSelection: { sourceVideoId: sourceVideo.id, sourceFps: 24, extractFps: 1, rangeStartMs: 1000, rangeEndMs: 2000, playheadMs: 1000, markers: [{ id: "before", timeMs: 500 }, { id: "inside", timeMs: 1500 }, { id: "after", timeMs: 2500 }] },
    });
    expect(project.sourceSelection).toMatchObject({ rangeStartMs: 1000, rangeEndMs: 2000, markers: [{ id: "inside", timeMs: 1500 }] });
  });

  it("removes legacy credential and model stores during the IndexedDB upgrade", async () => {
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    await new Promise<void>((resolve) => {
      const request = fakeIndexedDB.deleteDatabase("pixel-sprite-studio");
      request.onsuccess = () => resolve(); request.onerror = () => resolve();
    });
    await new Promise<void>((resolve, reject) => {
      const request = fakeIndexedDB.open("pixel-sprite-studio", 5);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("projects", { keyPath: "id" });
        request.result.createObjectStore("settings", { keyPath: "key" });
        request.result.createObjectStore("providerConnections", { keyPath: "providerId" });
        request.result.createObjectStore("providerCredentials", { keyPath: "providerId" }).put({ providerId: "legacy", apiKey: "secret" });
        request.result.createObjectStore("recentModels", { keyPath: "kind" });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    await loadLastProject();
    const names = await new Promise<string[]>((resolve, reject) => {
      const request = fakeIndexedDB.open("pixel-sprite-studio", 6);
      request.onsuccess = () => { const result = [...request.result.objectStoreNames]; request.result.close(); resolve(result); };
      request.onerror = () => reject(request.error);
    });
    expect(names).toEqual(["projects", "settings"]);
  });

  it("strips nested secrets from exported data", () => {
    expect(stripSecrets({ apiKey: "secret", nested: { authorization: "Bearer secret", model: "local" } })).toEqual({ nested: { model: "local" } });
  });
});

describe("prompt template registry", () => {
  it("provides one extensible template per workflow", () => {
    expect(getPromptTemplates("image").map((item) => item.id)).toEqual(["animation-ready-character-v1"]);
    expect(getPromptTemplates("video").map((item) => item.id)).toEqual(["seamless-in-place-v1"]);
    expect(getPromptTemplate("image", "missing")?.id).toBe("animation-ready-character-v1");
  });

  it("preserves Chinese or English user text at the beginning of the prompt", () => {
    const result = generatePrompt("animation-ready-character-v1", { kind: "image", userText: "  身穿银色铠甲的强壮战士  ", backgroundMode: "transparent", chromaKey: "magenta" });
    expect(result.prompt.startsWith("身穿银色铠甲的强壮战士\n")).toBe(true);
    expect(result.prompt).toContain("256×256 pixel art");
    expect(result.prompt).not.toContain("high-resolution");
    expect(result.prompt).toContain("#FF00FF");
  });

  it("uses the selected image prompt size instead of a hardcoded dimension", () => {
    const result = generatePrompt("animation-ready-character-v1", { kind: "image", userText: "forest mage", backgroundMode: "transparent", chromaKey: "magenta", imageSize: 64 });
    expect(result.prompt).toContain("native 64×64 pixel art");
    expect(result.prompt).not.toContain("256×256 pixel art");
  });

  it("uses a concise action placeholder without changing multilingual input support", () => {
    const template = getPromptTemplate("video", "seamless-in-place-v1");
    expect(template?.inputPlaceholder).toBe("Describe the motion, for example: walk in place with a confident heavy stride.");
    expect(template?.inputPlaceholder).not.toContain("Chinese");
    const result = generatePrompt("seamless-in-place-v1", { kind: "video", userText: "原地挥剑", backgroundMode: "transparent", chromaKey: "green" });
    expect(result.prompt.startsWith("原地挥剑\n")).toBe(true);
  });

  it("switches a magenta-conflicting subject to green and produces deterministic output", () => {
    expect(resolveChromaKey("a purple wizard", "magenta")).toBe("green");
    const input = { kind: "image" as const, userText: "a purple wizard", backgroundMode: "transparent" as const, chromaKey: "magenta" as const };
    expect(generatePrompt("animation-ready-character-v1", input)).toEqual(generatePrompt("animation-ready-character-v1", input));
    expect(generatePrompt("animation-ready-character-v1", input).prompt).toContain("#00FF00");
  });

  it("omits the chroma contract for opaque output", () => {
    const result = generatePrompt("animation-ready-character-v1", { kind: "image", userText: "blue knight", backgroundMode: "opaque", chromaKey: "magenta" });
    expect(result.prompt).not.toContain("BACKGROUND EXTRACTION CONTRACT");
  });

  it("builds a video prompt with action first and a locked background", () => {
    const result = generatePrompt("seamless-in-place-v1", { kind: "video", userText: "walk heavily in place", backgroundMode: "transparent", chromaKey: "green" });
    expect(result.prompt.startsWith("walk heavily in place\n")).toBe(true);
    expect(result.prompt).toContain("VIDEO CHROMA LOCK");
    expect(buildVideoChromaPrompt("walk", "green")).toContain("Preserve the exact #00FF00");
    expect(buildChromaPrompt("warrior", "green")).toContain("edge to edge");
  });

  it("rejects empty input", () => {
    expect(() => generatePrompt("animation-ready-character-v1", { kind: "image", userText: "  ", backgroundMode: "transparent", chromaKey: "magenta" })).toThrow("subject");
  });
});

describe("local frame and pixel processing", () => {
  it("calculates all original-frame export fitting modes", () => {
    expect(originalFrameDrawTransform(1920, 1080, 256, "contain")).toEqual({
      sourceX: 0, sourceY: 0, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 256, outputHeight: 144,
    });
    expect(originalFrameDrawTransform(1920, 1080, 256, "crop")).toEqual({
      sourceX: 420, sourceY: 0, sourceWidth: 1080, sourceHeight: 1080, outputWidth: 256, outputHeight: 256,
    });
    expect(originalFrameDrawTransform(1920, 1080, 256, "stretch")).toEqual({
      sourceX: 0, sourceY: 0, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 256, outputHeight: 256,
    });
  });

  it("keeps portrait proportions when the target represents the long edge", () => {
    expect(originalFrameDrawTransform(1080, 1920, 128, "contain")).toMatchObject({ outputWidth: 72, outputHeight: 128 });
  });

  it("supports marker math for fractional source frame rates", () => {
    expect(timeForSourceFrame(24, 23.976, 2000)).toBeCloseTo(1001.001, 2);
    expect(frameIndexAtTime(1001, 23.976, 2000)).toBe(24);
    expect(sourceFrameCount(2000, 24)).toBe(48);
    expect(createAutomaticMarkers(1000, 12)).toHaveLength(12);
    expect(createAutomaticMarkers(6000, 2, 24, 1000, 2000).map((marker) => marker.timeMs)).toEqual([1000, 1500]);
    expect(normalizeExtractFps(29)).toBe(24);
    expect(normalizePlaybackFps(0)).toBe(1);
    expect(normalizePlaybackFps(90)).toBe(60);
    expect(automaticMarkerCount(12_000, 24)).toBe(288);
    expect(() => createAutomaticMarkers(12_000, 24)).toThrow("Lower Extract FPS");
    const added = addSourceMarker([], 500, 24, 2000);
    expect(addSourceMarker(added, 501, 24, 2000)).toHaveLength(1);
    expect(moveSourceMarker([{ id: "a", timeMs: 100 }, { id: "b", timeMs: 300 }], "a", 500, 24, 1000)[0].timeMs).toBeLessThan(300);
  });

  it("composites transparent references on an opaque exact chroma key", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 128, 20, 40, 60, 255]);
    const result = compositeReferenceOnChroma(new ImageData(data, 3, 1), "magenta");
    expect([...result.imageData.data.slice(0, 4)]).toEqual([255, 0, 255, 255]);
    expect([...result.imageData.data.slice(4, 8)]).toEqual([127, 0, 127, 255]);
    expect([...result.imageData.data.slice(8, 12)]).toEqual([20, 40, 60, 255]);
  });

  it("removes only the connected chroma background and prepares a video reference", () => {
    const width = 8;
    const data = new Uint8ClampedArray(width * width * 4);
    for (let index = 0; index < width * width; index++) data.set([255, 0, 255, 255], index * 4);
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) data.set([20, 80, 220, 255], (y * width + x) * 4);
    const source = new ImageData(data, width, width);
    expect(removeChromaBackground(source, "magenta").stats.success).toBe(true);
    expect(validateExternalVideoReference(source, "magenta").normalizationReady).toBe(true);
    expect(prepareExternalVideoReference(source, "magenta").success).toBe(true);
  });

  it("repairs hidden chroma RGB in translucent matte edges before quantization", () => {
    const width = 9;
    const data = new Uint8ClampedArray(width * width * 4);
    for (let index = 0; index < width * width; index++) data.set([255, 0, 255, 255], index * 4);
    for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) data.set([180, 35, 180, 255], (y * width + x) * 4);
    for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) data.set([60, 65, 70, 255], (y * width + x) * 4);
    const matte = removeChromaBackground(new ImageData(data, width, width), "magenta").imageData;
    const translucent: number[][] = [];
    for (let offset = 0; offset < matte.data.length; offset += 4) {
      const alpha = matte.data[offset + 3];
      if (alpha > 0 && alpha < 250) translucent.push([...matte.data.slice(offset, offset + 4)]);
      if (alpha === 0) expect([...matte.data.slice(offset, offset + 3)]).toEqual([0, 0, 0]);
    }
    expect(translucent.length).toBeGreaterThan(0);
    expect(translucent.every(([r, g, b]) => Math.max(r, b) - g < 80)).toBe(true);
  });

  it("clears enclosed exact-key background holes without deleting similar subject colors", () => {
    const width = 9;
    const data = new Uint8ClampedArray(width * width * 4);
    for (let index = 0; index < width * width; index++) data.set([255, 0, 255, 255], index * 4);
    for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) {
      const border = x === 2 || x === 6 || y === 2 || y === 6;
      data.set(border ? [15, 15, 15, 255] : [255, 0, 255, 255], (y * width + x) * 4);
    }
    data.set([210, 55, 185, 255], (4 * width + 3) * 4);
    const matte = removeChromaBackground(new ImageData(data, width, width), "magenta").imageData;
    expect(matte.data[(4 * width + 4) * 4 + 3]).toBe(0);
    expect(matte.data[(4 * width + 3) * 4 + 3]).toBe(255);
  });

  it("quantizes a shared palette and computes frame difference", () => {
    const a = new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]), 4, 1);
    const b = new ImageData(new Uint8ClampedArray([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]), 4, 1);
    const palette = dominantPalette([a, b], 2);
    expect(applyPalette(a, palette).data).toHaveLength(16);
    expect(frameDifference(a, b)).toBeGreaterThan(0);
  });

  it("detects a regular pseudo-pixel grid without confusing native dimensions", () => {
    const nativeSize = 12; const scale = 8; const size = nativeSize * scale;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = Math.floor(x / scale); const ny = Math.floor(y / scale);
      const offset = (y * size + x) * 4;
      data.set([(nx * 67 + ny * 13) % 256, (ny * 71 + nx * 17) % 256, ((nx + ny) * 53) % 256, 255], offset);
    }
    const grid = detectPseudoPixelGrid(new ImageData(data, size, size));
    expect(grid.detected).toBe(true);
    expect(grid.columns).toBe(nativeSize);
    expect(grid.rows).toBe(nativeSize);
    expect(grid.fftConfidence).toBeGreaterThan(0.2);
    expect(grid.xBoundaries).toHaveLength(nativeSize + 1);
    expect(grid.yBoundaries).toHaveLength(nativeSize + 1);
    const xIntervals = grid.xBoundaries!.slice(1).map((boundary, index) => boundary - grid.xBoundaries![index]);
    const yIntervals = grid.yBoundaries!.slice(1).map((boundary, index) => boundary - grid.yBoundaries![index]);
    expect(Math.max(...xIntervals) - Math.min(...xIntervals)).toBeLessThan(1e-9);
    expect(Math.max(...yIntervals) - Math.min(...yIntervals)).toBeLessThan(1e-9);
  });

  it("reproduces PerfectPixel's Sobel-gradient fallback when FFT is inconsistent", () => {
    const cellWidths = [24, 24, 24, 24, 24, 24];
    const cellHeights = [24, 24, 24, 24, 24, 24];
    const width = cellWidths.reduce((sum, value) => sum + value, 0);
    const height = cellHeights.reduce((sum, value) => sum + value, 0);
    const xBoundaries = [0]; const yBoundaries = [0];
    cellWidths.forEach((value) => xBoundaries.push(xBoundaries.at(-1)! + value));
    cellHeights.forEach((value) => yBoundaries.push(yBoundaries.at(-1)! + value));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let cellY = 0; cellY < cellHeights.length; cellY++) for (let cellX = 0; cellX < cellWidths.length; cellX++) {
      const color = [(cellX * 67 + cellY * 13) % 256, (cellY * 71 + cellX * 17) % 256, ((cellX + cellY) * 53) % 256, 255];
      for (let y = yBoundaries[cellY]; y < yBoundaries[cellY + 1]; y++) for (let x = xBoundaries[cellX]; x < xBoundaries[cellX + 1]; x++) {
        data.set(color, (y * width + x) * 4);
      }
    }
    const horizontal = new Uint8ClampedArray(data.length); const softened = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) {
      const left = (y * width + Math.max(0, x - 1)) * 4 + channel;
      const center = (y * width + x) * 4 + channel;
      const right = (y * width + Math.min(width - 1, x + 1)) * 4 + channel;
      horizontal[center] = data[left] * 0.28 + data[center] * 0.61 + data[right] * 0.11;
      horizontal[center - channel + 3] = 255;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) {
      const above = (Math.max(0, y - 1) * width + x) * 4 + channel;
      const center = (y * width + x) * 4 + channel;
      const below = (Math.min(height - 1, y + 1) * width + x) * 4 + channel;
      softened[center] = horizontal[above] * 0.28 + horizontal[center] * 0.61 + horizontal[below] * 0.11;
      softened[center - channel + 3] = 255;
    }
    const source = new ImageData(softened, width, height);
    const grid = detectPseudoPixelGrid(source);
    expect(grid.detected).toBe(true);
    expect(grid.fftValid).toBe(false);
    expect(grid.gradientFallbackUsed).toBe(true);
    expect(grid.xBoundaries).toHaveLength((grid.alignedColumns ?? grid.columns) + 1);
    expect(grid.yBoundaries).toHaveLength((grid.alignedRows ?? grid.rows) + 1);
    expect(pixelateImageData(source, grid.columns, grid.rows, 24).gridRecovered).toBe(true);
  });

  it("does not recover a grid from a flat image with no periodic evidence", () => {
    const size = 96; const data = new Uint8ClampedArray(size * size * 4);
    for (let offset = 0; offset < data.length; offset += 4) data.set([80, 100, 120, 255], offset);
    const grid = detectPseudoPixelGrid(new ImageData(data, size, size));
    expect(grid.detected).toBe(false);
    expect(grid.fftConfidence).toBe(0);
  });

  it("reuses an extraction-time grid for animation pixelation", () => {
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const light = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      data.set(light ? [230, 230, 230, 255] : [25, 25, 25, 255], (y * 8 + x) * 4);
    }
    const source = new ImageData(data, 8, 8);
    const grid = {
      detected: true, stepX: 4, stepY: 4, columns: 2, rows: 2, confidence: 0.8,
      fftConfidence: 0.8, fftValid: true,
      xBoundaries: [0, 4, 8], yBoundaries: [0, 4, 8],
    };
    const result = pixelateAnimationFrames([source], 2, 2, 4, [source], grid);
    expect(result.grid).toBe(grid);
    expect([result.frames[0].width, result.frames[0].height]).toEqual([2, 2]);
  });

  it("keeps a thin high-contrast feature that nearest-neighbor sampling misses", () => {
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 1; y < 7; y++) data.set([245, 245, 245, 255], (y * 8 + 3) * 4);
    const source = new ImageData(data, 8, 8);
    const legacy = legacyPixelateImageData(source, 2, 2, 4);
    const improved = edgeAwareDownscale(source, 2, 2);
    const legacyOpaque = [...legacy.data].filter((_, index) => index % 4 === 3 && legacy.data[index] > 0).length;
    const improvedOpaque = [...improved.data].filter((_, index) => index % 4 === 3 && improved.data[index] > 0).length;
    expect(improvedOpaque).toBeGreaterThan(legacyOpaque);
  });

  it("crops transparent margins before fitting a standard output canvas", () => {
    const data = new Uint8ClampedArray(12 * 12 * 4);
    for (let y = 4; y < 8; y++) for (let x = 5; x < 7; x++) data.set([230, 210, 180, 255], (y * 12 + x) * 4);
    const result = pixelateImageData(new ImageData(data, 12, 12), 8, 8, 8, { recoverGrid: false, quantize: false });
    let minX = 8; let minY = 8; let maxX = -1; let maxY = -1;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (result.imageData.data[(y * 8 + x) * 4 + 3] > 16) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    expect([maxX - minX + 1, maxY - minY + 1]).toEqual([2, 4]);
  });

  it("uses one union crop for animation frames so motion does not recenter per frame", () => {
    const makeFrame = (left: number) => {
      const data = new Uint8ClampedArray(12 * 12 * 4);
      for (let y = 3; y < 9; y++) for (let x = left; x < left + 2; x++) data.set([240, 220, 190, 255], (y * 12 + x) * 4);
      return new ImageData(data, 12, 12);
    };
    const result = pixelateAnimationFrames([makeFrame(1), makeFrame(9)], 8, 8, 8);
    const centroid = (frame: ImageData) => {
      let weightedX = 0; let mass = 0;
      for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
        const alpha = frame.data[(y * frame.width + x) * 4 + 3]; weightedX += x * alpha; mass += alpha;
      }
      return weightedX / mass;
    };
    expect(centroid(result.frames[1]) - centroid(result.frames[0])).toBeGreaterThan(3);
  });

  it("produces a deterministic bounded palette and a target-sized optimized result", () => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let index = 0; index < 16 * 16; index++) data.set([index % 255, (index * 7) % 255, (index * 19) % 255, 255], index * 4);
    const source = new ImageData(data, 16, 16);
    expect(dominantPalette([source], 8)).toEqual(dominantPalette([source], 8));
    const result = pixelateImageData(source, 8, 8, 8, { recoverGrid: false });
    expect([result.imageData.width, result.imageData.height, result.palette.length]).toEqual([8, 8, 8]);
  });
});

describe("editor, canvas and export", () => {
  it("supports undo and redo", () => {
    const initial = createProject("one");
    const changed = commit(createHistory(initial), { ...initial, name: "two" });
    expect(undo(changed).present.name).toBe("one");
    expect(redo(undo(changed)).present.name).toBe("two");
  });

  it("uses real pixel zoom dimensions", () => {
    expect(zoomIn(7)).toBe(8);
    expect(zoomOut(7)).toBe(6);
    expect(zoomOut(1)).toBe(.75);
    expect(zoomIn(.25)).toBe(.5);
    expect(canvasDisplaySize(544, 544, .25)).toEqual({ width: 136, height: 136 });
    expect(canvasDisplaySize(64, 48, 10)).toEqual({ width: 640, height: 480 });
    expect(fitCanvasZoom(1080, 1920, 500, 500, 100)).toBeCloseTo(400 / 1920);
    expect(fitCanvasZoom(10_000, 10_000, 400, 400, 100)).toBeLessThan(.25);
  });

  it("maps frames to exact sprite sheet cells", () => {
    const project = createProject("test");
    project.frames = [0, 1, 2].map((index) => ({ id: `${index}`, name: `${index}`, dataUrl: "data:image/png;base64,AA==", durationMs: 100, offsetX: 0, offsetY: 0, mirrored: false, warnings: [], width: 64, height: 64, processing: "pixel-art" as const }));
    expect(buildManifest(project, 2).frames[2].frame).toEqual({ x: 0, y: 64, w: 64, h: 64 });
  });

  it("uses original frame dimensions and rejects mixed frame sizes", () => {
    const project = createProject("raw");
    project.frames = [0, 1].map((index) => ({ id: `${index}`, name: `${index}`, dataUrl: "data:image/png;base64,AA==", durationMs: 100, offsetX: 0, offsetY: 0, mirrored: false, warnings: [], width: 320, height: 180, processing: "original" as const }));
    expect(buildManifest(project, 2).frameSize).toEqual({ w: 320, h: 180 });
    expect(() => frameSetDimensions([...project.frames, { ...project.frames[0], id: "mixed", width: 64 }])).toThrow("same dimensions");
  });
});
