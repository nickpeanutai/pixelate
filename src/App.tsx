import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise, CaretDown, CaretUp, Copy, DownloadSimple,
  FilmStrip, GithubLogo, GridFour,
  ImageSquare, MagicWand, Minus, Pause, Play, Plus,
  SelectionBackground, Sparkle, Star, Trash, UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { createHistory, commit, redo, undo } from "@pixel-sprite/editor-core";
import { downloadBlob, composeSpriteSheet, frameSetDimensions } from "@pixel-sprite/export-core";
import { detectPseudoPixelGrid, pixelateAnimationFrames, processImageUrl, removeChromaBackground, validateExternalVideoReference, type ChromaKeyName, type PixelGridDetection, type VideoReferenceAssessment } from "@pixel-sprite/pixel-core";
import {
  createProject, DEFAULT_PROMPT_IMAGE_SIZE, deleteReferenceImage, deleteSourceImage,
  deleteSourceVideo, loadLastProject, loadReferenceImage, loadSourceImage,
  PROMPT_IMAGE_SIZES,
  loadSourceVideo, saveProjectMetadata, saveReferenceImage, saveSourceImage,
  saveSourceVideo, type PixelProject, type ProjectFrame, type ReferenceImageMetadata,
  type PromptImageSize, type SourceFrameSelection, type SourceImageMetadata, type SourceVideoMetadata,
} from "@pixel-sprite/project-schema";
import { SourceFramePicker } from "./SourceFramePicker";
import { canvasDisplaySize, fitCanvasZoom, maxZoom, minZoom, zoomIn, zoomOut } from "./canvas-view";
import { normalizePlaybackFps } from "./frame-picker";
import { originalFrameDrawTransform, type OriginalFrameFitting } from "./frame-output";
import { generatePrompt, getPromptTemplate, getPromptTemplates } from "./external-prompt";
import { fetchGitHubStars, formatStarCount, GITHUB_REPOSITORY_URL, readCachedGitHubStars } from "./github-stars";
import "./styles.css";

type Toast = { kind: "success" | "error" | "info"; message: string } | null;
type SourceVideoAsset = { blob: Blob; url: string; metadata: SourceVideoMetadata };
type ReferenceImageAsset = { blob: Blob; url: string; metadata: ReferenceImageMetadata };
type SourceImageAsset = { blob: Blob; url: string; metadata: SourceImageMetadata };
type ExtractedFrame = { frame: ProjectFrame; imageData: ImageData; timeMs: number };
type PendingFrameSet = { sourceVideoId: string; frames: ExtractedFrame[]; gridDetection: PixelGridDetection; applied: boolean };
type PixelationWarning = { mediaKind: "image" | "video"; chromaKey: ChromaKeyName; reason: string };

const referenceDragType = "application/x-pixel-sprite-reference";
const referenceDragFallbackPrefix = "pixel-sprite-reference:v1:";
const supportedReferenceTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxReferenceSize = 10 * 1024 * 1024;

const sizePresets = [16, 32, 48, 64, 96, 128, 256];
const exportNameStem = (filename: string) => filename
  .replace(/\.[^./]+$/, "")
  .trim()
  .replace(/\s+/g, "-")
  .replace(/[^a-zA-Z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "") || "pixel-image";
const frameName = (index: number) => `Frame ${String(index + 1).padStart(2, "0")}`;
const makeFrame = (dataUrl: string, index: number, fps: number, width: number, height: number, processing: ProjectFrame["processing"]): ProjectFrame => ({
  id: crypto.randomUUID(), name: frameName(index), dataUrl, durationMs: Math.round(1000 / fps),
  offsetX: 0, offsetY: 0, mirrored: false, warnings: [], width, height, processing,
});

async function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("The image could not be read"));
    reader.readAsDataURL(blob);
  });
}

async function inspectImage(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The reference image could not be decoded"));
      image.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageDataFromBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The source image could not be decoded"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height) throw new Error("The source image is empty");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally { URL.revokeObjectURL(url); }
}

async function normalizeReferenceBlob(blob: Blob) {
  const type = blob.type.toLowerCase();
  if (type === "image/jpg") return blob.slice(0, blob.size, "image/jpeg");
  if (supportedReferenceTypes.has(type)) return blob;
  if (type) throw new Error("Reference images must be PNG, JPEG or WebP.");
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Reference images must be PNG, JPEG or WebP."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    return canvasToBlob(canvas);
  } finally { URL.revokeObjectURL(url); }
}

async function captureVideoFrame(videoUrl: string, timeMs: number) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = videoUrl;
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("The source video metadata could not be decoded")), { once: true });
    });
    const target = Math.min(Math.max(0, timeMs / 1000), Math.max(0, video.duration - 0.001));
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("The selected source frame could not be decoded")), { once: true });
      video.currentTime = target;
    });
    if ("requestVideoFrameCallback" in video) await Promise.race([
      new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())),
      new Promise<void>((resolve) => window.setTimeout(resolve, 150)),
    ]);
    if (!video.videoWidth || !video.videoHeight) throw new Error("The selected source frame has no decodable pixels");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvasToBlob(canvas);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function composeVisibleFrame(frame: ProjectFrame, width: number, height: number) {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The canvas frame could not be decoded"));
    image.src = frame.dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.save();
  context.translate(frame.offsetX, frame.offsetY);
  if (frame.mirrored) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(image, 0, 0, width, height);
  context.restore();
  return canvasToBlob(canvas);
}

const rgbToHex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

async function inspectVideo(blobUrl: string) {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.src = blobUrl;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("This browser could not read the source video metadata"));
  });
  return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
}


class VideoExtractionError extends Error {
  constructor(message: string, readonly failedIndices: number[] = []) { super(message); }
}

async function seekForExtraction(video: HTMLVideoElement, timeMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const target = Math.min(Math.max(0, timeMs / 1000), Math.max(0, video.duration - 0.001));
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new DOMException("Extraction cancelled", "AbortError")); };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("The selected video frame could not be decoded")); };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = target;
  });
  signal.throwIfAborted();
  if ("requestVideoFrameCallback" in video) {
    await Promise.race([
      new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())),
      new Promise<void>((resolve) => window.setTimeout(resolve, 120)),
    ]);
  }
}

async function extractVideoFrames(file: File, selectedTimesMs: number[], fps: number, signal: AbortSignal, onProgress: (progress: number) => void): Promise<ExtractedFrame[]> {
  const times = [...new Set(selectedTimesMs)].sort((a, b) => a - b);
  if (!times.length) throw new VideoExtractionError("Select at least one source frame before extraction");
  if (times.length > 240) throw new VideoExtractionError(`Select no more than 240 source frames before extraction (received ${times.length})`);
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = url;
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("This browser could not decode the video")); });
    const count = times.length;
    const sourceCanvas = document.createElement("canvas"); sourceCanvas.width = video.videoWidth; sourceCanvas.height = video.videoHeight;
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
    const extracted: ExtractedFrame[] = [];

    for (let index = 0; index < count; index++) {
      await seekForExtraction(video, times[index], signal);
      sourceContext.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      sourceContext.drawImage(video, 0, 0);
      const source = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      extracted.push({
        frame: makeFrame(sourceCanvas.toDataURL("image/png"), index, fps, sourceCanvas.width, sourceCanvas.height, "original"),
        imageData: source,
        timeMs: times[index],
      });
      onProgress((index + 1) / count);
    }
    return extracted;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pixelateExtractedFrames(frames: ExtractedFrame[], width: number, height: number, fps: number, paletteSize: number, backgroundMode: "transparent" | "opaque", chromaKey: ChromaKeyName, gridDetection: PixelGridDetection | undefined, signal: AbortSignal, onProgress: (progress: number) => void) {
    if (!frames.length) throw new VideoExtractionError("Extract frames before pixel processing");
    const count = frames.length;
    const validated: ImageData[] = [];
    const failures: Array<{ index: number; reason: string; detected: [number, number, number] }> = [];
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const source = frames[index].imageData;
      if (backgroundMode === "transparent") {
        const matte = removeChromaBackground(source, chromaKey);
        validated.push(matte.imageData);
        if (!matte.stats.success) failures.push({ index, reason: matte.stats.reason || "Chroma validation failed", detected: matte.stats.detectedKey });
      } else validated.push(source);
      onProgress((index + 1) / count * 0.45);
    }
    if (failures.length) {
      const first = failures[0];
      const expected = chromaKey === "magenta" ? "#FF00FF" : "#00FF00";
      const alternate = chromaKey === "magenta" ? "green" : "magenta";
      throw new VideoExtractionError(`${failures.length} of ${count} selected frames failed chroma validation. First failure: Selection ${first.index + 1}: ${first.reason}. Selected ${chromaKey} key ${expected}; detected background ${rgbToHex(first.detected)}. Regenerate with the ${alternate} key.`, failures.map((failure) => failure.index));
    }

    signal.throwIfAborted();
    // Detect the grid from the untouched video frames, then apply that fixed
    // PerfectPixel grid to the chroma-matted frames.
    const processed = pixelateAnimationFrames(validated, width, height, paletteSize, frames.map((frame) => frame.imageData), gridDetection);
    onProgress(0.75);
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.imageSmoothingEnabled = false;
    return processed.frames.map((imageData, index) => {
      signal.throwIfAborted();
      context.putImageData(imageData, 0, 0);
      onProgress(0.75 + (index + 1) / count * 0.25);
      return makeFrame(canvas.toDataURL("image/png"), index, fps, width, height, "pixel-art");
    });
}

async function prepareOriginalFrames(
  frames: ExtractedFrame[],
  targetSize: number | null,
  fitting: OriginalFrameFitting,
  fps: number,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<ProjectFrame[]> {
  if (!frames.length) throw new VideoExtractionError("Extract frames before preparing output");
  if (targetSize === null) {
    return frames.map(({ frame }, index) => {
      signal.throwIfAborted();
      onProgress((index + 1) / frames.length);
      return { ...frame, durationMs: Math.round(1000 / fps), processing: "original" };
    });
  }

  const sourceCanvas = document.createElement("canvas");
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const outputCanvas = document.createElement("canvas");
  const outputContext = outputCanvas.getContext("2d");
  if (!sourceContext || !outputContext) throw new Error("Canvas is unavailable for frame resizing");
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";

  return frames.map(({ imageData }, index) => {
    signal.throwIfAborted();
    const transform = originalFrameDrawTransform(imageData.width, imageData.height, targetSize, fitting);
    sourceCanvas.width = imageData.width;
    sourceCanvas.height = imageData.height;
    sourceContext.putImageData(imageData, 0, 0);
    outputCanvas.width = transform.outputWidth;
    outputCanvas.height = transform.outputHeight;
    outputContext.imageSmoothingEnabled = true;
    outputContext.imageSmoothingQuality = "high";
    outputContext.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
    outputContext.drawImage(
      sourceCanvas,
      transform.sourceX,
      transform.sourceY,
      transform.sourceWidth,
      transform.sourceHeight,
      0,
      0,
      transform.outputWidth,
      transform.outputHeight,
    );
    onProgress((index + 1) / frames.length);
    return makeFrame(outputCanvas.toDataURL("image/png"), index, fps, transform.outputWidth, transform.outputHeight, "original");
  });
}

function IconButton({ label, children, onClick, active, disabled }: { label: string; children: React.ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button ${active ? "is-active" : ""}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function AppLogo() {
  return <div className="brand"><div className="brand-mark"><img src="/assets/b-avatar.jpg" alt="" /></div><span>Pixelate</span></div>;
}

function GitHubStarPill() {
  const [starCount, setStarCount] = useState<number | undefined>(() => readCachedGitHubStars());

  useEffect(() => {
    let active = true;
    void fetchGitHubStars().then((count) => {
      if (active && count !== undefined) setStarCount(count);
    });
    return () => { active = false; };
  }, []);

  const starLabel = starCount === undefined
    ? "View Pixelate source code on GitHub"
    : `View Pixelate source code on GitHub, ${starCount.toLocaleString("en")} GitHub ${starCount === 1 ? "star" : "stars"}`;

  return (
    <a className="github-pill" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label={starLabel} title="View source on GitHub">
      <GithubLogo weight="fill" />
      <span>GitHub</span>
      {starCount !== undefined && <span className="github-stars" aria-label={`${starCount.toLocaleString("en")} GitHub ${starCount === 1 ? "star" : "stars"}`}><Star weight="fill" /><span>{formatStarCount(starCount)}</span></span>}
    </a>
  );
}

export function App() {
  const initial = useMemo(() => createProject("Alchemist scout"), []);
  const [history, setHistory] = useState(() => createHistory(initial));
  const project = history.present;
  const [selectedFrame, setSelectedFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitCanvas, setFitCanvas] = useState(true);
  const [canvasStageSize, setCanvasStageSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  // Feedback is communicated through inline panel state; avoid interruptive
  // floating notifications over the editor workspace.
  const setToast = useCallback((_toast: Toast) => {}, []);
  const [sourceVideo, setSourceVideo] = useState<SourceVideoAsset | null>(null);
  const [referenceImage, setReferenceImage] = useState<ReferenceImageAsset | null>(null);
  const [sourceImage, setSourceImage] = useState<SourceImageAsset | null>(null);
  const [sourceGridDetection, setSourceGridDetection] = useState<PixelGridDetection | null>(null);
  const [videoReferenceAssessment, setVideoReferenceAssessment] = useState<VideoReferenceAssessment | null>(null);
  const [pixelationWarning, setPixelationWarning] = useState<PixelationWarning | null>(null);
  const [assessmentLoading, setAssessmentLoading] = useState(false);
  const [processedSourceId, setProcessedSourceId] = useState<string>();
  const [referenceDropActive, setReferenceDropActive] = useState(false);
  const [referencePreparing, setReferencePreparing] = useState(false);
  const [failedSourceMarkerIds, setFailedSourceMarkerIds] = useState<string[]>([]);
  const [pendingFrames, setPendingFrames] = useState<PendingFrameSet | null>(null);
  const [frameOutputChoice, setFrameOutputChoice] = useState<"original" | "pixel-art" | null>(null);
  const [frameOutputExpanded, setFrameOutputExpanded] = useState(true);
  const [originalExportSize, setOriginalExportSize] = useState<number | null>(null);
  const [originalFrameFitting, setOriginalFrameFitting] = useState<OriginalFrameFitting>("contain");
  const [workspaceView, setWorkspaceView] = useState<"frames" | "video">("frames");
  const [restoring, setRestoring] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const sourceImageInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const canvasStageRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  const restoredProjectRef = useRef(false);
  const sourceVideoUrlRef = useRef<string | null>(null);
  const referenceImageUrlRef = useRef<string | null>(null);
  const sourceImageUrlRef = useRef<string | null>(null);

  const replaceSourceVideo = useCallback((asset: SourceVideoAsset | null) => {
    if (sourceVideoUrlRef.current && sourceVideoUrlRef.current !== asset?.url) URL.revokeObjectURL(sourceVideoUrlRef.current);
    sourceVideoUrlRef.current = asset?.url || null;
    setSourceVideo(asset);
  }, []);

  const replaceReferenceImage = useCallback((asset: ReferenceImageAsset | null) => {
    if (referenceImageUrlRef.current && referenceImageUrlRef.current !== asset?.url) URL.revokeObjectURL(referenceImageUrlRef.current);
    referenceImageUrlRef.current = asset?.url || null;
    setReferenceImage(asset);
  }, []);

  const replaceSourceImage = useCallback((asset: SourceImageAsset | null) => {
    if (sourceImageUrlRef.current && sourceImageUrlRef.current !== asset?.url) URL.revokeObjectURL(sourceImageUrlRef.current);
    sourceImageUrlRef.current = asset?.url || null;
    setSourceImage(asset);
  }, []);

  const updateProject = useCallback((updater: (current: PixelProject) => PixelProject) => {
    setHistory((current) => commit(current, { ...updater(current.present), updatedAt: new Date().toISOString() }));
  }, []);

  const processImage = useCallback(async (url: string, name = "Pixel image", chromaKey?: ChromaKeyName) => {
    setBusy(true); setProgress(0.2);
    try {
      const result = await processImageUrl(url, project.target.width, project.target.height, project.target.paletteSize, { chromaKey, gridHint: sourceGridDetection?.detected ? sourceGridDetection : undefined });
      if (result.chroma && !result.chroma.success) {
        const alternate = chromaKey === "magenta" ? "green" : "magenta";
        throw new Error(`${result.chroma.reason}. Regenerate using the ${alternate} key.`);
      }
      const canvas = result.canvas;
      setProgress(0.8);
      const dataUrl = canvas.toDataURL("image/png");
      const frame = makeFrame(dataUrl, 0, project.target.fps, project.target.width, project.target.height, "pixel-art");
      updateProject((current) => ({ ...current, mode: "image", frames: [frame] }));
      setSelectedFrame(0); setFitCanvas(true); setProgress(1); setToast({ kind: "success", message: chromaKey ? "Chroma background removed and pixel image processed locally" : "Pixel image processed locally" });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image processing failed";
      if (chromaKey) setPixelationWarning({ mediaKind: "image", chromaKey, reason: message });
      setToast({ kind: "error", message });
      return false;
    }
    finally { setBusy(false); }
  }, [project.target, sourceGridDetection, updateProject]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        let saved = await loadLastProject();
        if (!active || !saved) return;
        restoredProjectRef.current = true;
        const restoreMessages: string[] = [];
        if (saved.sourceImage) {
          let blob: Blob | undefined;
          try { blob = await loadSourceImage(saved.id, saved.sourceImage.id); }
          catch { blob = undefined; }
          if (!active) return;
          if (blob) replaceSourceImage({ blob, url: URL.createObjectURL(blob), metadata: saved.sourceImage });
          else {
            saved = { ...saved, sourceImage: undefined };
            restoreMessages.push("External source image is unavailable and its stale project reference was removed.");
          }
        }
        if (saved.referenceImage) {
          let blob: Blob | undefined;
          try { blob = await loadReferenceImage(saved.id, saved.referenceImage.id); }
          catch { blob = undefined; }
          if (!active) return;
          if (blob) {
            replaceReferenceImage({ blob, url: URL.createObjectURL(blob), metadata: saved.referenceImage });
          } else {
            saved = { ...saved, referenceImage: undefined };
            restoreMessages.push("Source reference image is unavailable and its stale project reference was removed.");
          }
        }
        if (saved.sourceVideo) {
          let blob: Blob | undefined;
          try { blob = await loadSourceVideo(saved.id, saved.sourceVideo.id); }
          catch { blob = undefined; }
          if (!active) return;
          if (blob) {
            const url = URL.createObjectURL(blob);
            replaceSourceVideo({ blob, url, metadata: saved.sourceVideo });
            if (!saved.sourceSelection || saved.sourceSelection.sourceVideoId !== saved.sourceVideo.id) {
              saved = { ...saved, sourceSelection: { sourceVideoId: saved.sourceVideo.id, sourceFps: 24, extractFps: 1, rangeStartMs: 0, rangeEndMs: saved.sourceVideo.duration * 1000, playheadMs: 0, markers: [] } };
            }
            setWorkspaceView("video");
          } else {
            saved = { ...saved, sourceVideo: undefined, sourceSelection: undefined };
            restoreMessages.push("Source video is unavailable and its stale project reference was removed.");
          }
        }
        setHistory(createHistory(saved));
        if (restoreMessages.length) {
          await saveProjectMetadata(saved);
          setToast({ kind: "info", message: restoreMessages.join(" ") });
        }
      } catch (error) {
        if (active) setToast({ kind: "info", message: `Local project restore was skipped: ${error instanceof Error ? error.message : "storage unavailable"}` });
      } finally {
        if (active) setRestoring(false);
      }
    })();
    return () => { active = false; };
  }, [replaceReferenceImage, replaceSourceImage, replaceSourceVideo]);

  useEffect(() => () => {
    if (sourceVideoUrlRef.current) URL.revokeObjectURL(sourceVideoUrlRef.current);
    if (referenceImageUrlRef.current) URL.revokeObjectURL(referenceImageUrlRef.current);
    if (sourceImageUrlRef.current) URL.revokeObjectURL(sourceImageUrlRef.current);
  }, []);

  useEffect(() => {
    const stage = canvasStageRef.current;
    if (!stage) return;
    const updateSize = () => setCanvasStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!project.sourceSelection) return;
    const timer = window.setTimeout(() => { void saveProjectMetadata(project); }, 300);
    return () => window.clearTimeout(timer);
  }, [project.sourceSelection]);

  useEffect(() => {
    if (restoring) return;
    const timer = window.setTimeout(() => { void saveProjectMetadata(project); }, 300);
    return () => window.clearTimeout(timer);
  }, [project.promptWorkflow, restoring]);

  useEffect(() => {
    if (restoring) return;
    const timer = window.setTimeout(() => { void saveProjectMetadata(project); }, 300);
    return () => window.clearTimeout(timer);
  }, [project.target.fps, restoring]);

  useEffect(() => {
    if (restoring || seededRef.current) return;
    seededRef.current = true;
    if (!restoredProjectRef.current) processImage("/assets/demo-alchemist.png", "Demo alchemist");
  }, [processImage, restoring]);

  const activePendingFrames = project.mode === "animation" ? pendingFrames : null;
  const pendingFramePreview = Boolean(activePendingFrames && !activePendingFrames.applied);
  const displayedFrames = activePendingFrames && !activePendingFrames.applied
    ? activePendingFrames.frames.map(({ frame }) => frame)
    : project.frames;

  useEffect(() => {
    if (!playing || displayedFrames.length < 2) return;
    const timer = window.setInterval(() => setSelectedFrame((index) => (index + 1) % displayedFrames.length), 1000 / project.target.fps);
    return () => clearInterval(timer);
  }, [playing, displayedFrames.length, project.target.fps]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest(".source-picker")) return;
      if ((event.target as HTMLElement)?.matches("input, textarea, select")) return;
      if (event.code === "Space") { event.preventDefault(); setPlaying((value) => !value); }
      if (event.key === "ArrowLeft") setSelectedFrame((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setSelectedFrame((value) => Math.min(displayedFrames.length - 1, value + 1));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); setHistory((value) => event.shiftKey ? redo(value) : undo(value)); }
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [displayedFrames.length]);

  const currentFrame = displayedFrames[selectedFrame];
  const unprocessedSourceVisible = project.mode === "image" && !currentFrame && Boolean(sourceImage);
  const currentFrameWidth = currentFrame?.width || (unprocessedSourceVisible ? sourceImage!.metadata.width : project.target.width);
  const currentFrameHeight = currentFrame?.height || (unprocessedSourceVisible ? sourceImage!.metadata.height : project.target.height);
  const sourceVideoViewActive = project.mode === "animation" && workspaceView === "video" && Boolean(sourceVideo);
  const effectiveZoom = fitCanvas && (currentFrame || unprocessedSourceVisible)
    ? fitCanvasZoom(currentFrameWidth, currentFrameHeight, canvasStageSize.width, canvasStageSize.height, 96)
    : zoom;
  const previewSize = canvasDisplaySize(currentFrameWidth, currentFrameHeight, effectiveZoom);
  const promptKind = project.mode === "animation" ? "video" as const : "image" as const;
  const promptDraft = project.promptWorkflow[promptKind];
  const availablePromptTemplates = getPromptTemplates(promptKind);
  const activePromptTemplate = getPromptTemplate(promptKind, promptDraft.templateId);
  const effectiveExternalChromaKey = project.target.chromaKey;

  useEffect(() => {
    let active = true;
    if (!sourceImage) {
      setSourceGridDetection(null);
      setVideoReferenceAssessment(null);
      setAssessmentLoading(false);
      return () => { active = false; };
    }
    const assessVideoReference = project.target.backgroundMode === "transparent";
    setSourceGridDetection(null);
    if (!assessVideoReference) setVideoReferenceAssessment(null);
    setAssessmentLoading(true);
    void imageDataFromBlob(sourceImage.blob).then((imageData) => {
      if (!active) return;
      // PerfectPixel measures the untouched source. Chroma removal happens
      // later and receives this chosen grid as an immutable processing hint.
      const gridDetection = detectPseudoPixelGrid(imageData);
      setSourceGridDetection(gridDetection);
      if (gridDetection.detected && project.target.pixelSizeMode !== "manual"
        && (project.target.width !== gridDetection.columns || project.target.height !== gridDetection.rows)) {
        updateProject((current) => ({ ...current, target: { ...current.target, width: gridDetection.columns, height: gridDetection.rows, pixelSizeMode: "detected" } }));
      }
      if (assessVideoReference) setVideoReferenceAssessment(validateExternalVideoReference(imageData, effectiveExternalChromaKey));
    }).catch((error) => {
      if (!active) return;
      setSourceGridDetection(null);
      if (assessVideoReference) setVideoReferenceAssessment({
          pixelProcessingReady: false, videoReady: false, normalizationReady: false, requiresNormalization: false, detectedKey: [0, 0, 0], opaqueRatio: 0,
          edgeContactRatio: 1, minimumMarginRatio: 0, fullyOpaque: false, warnings: [],
          failures: [error instanceof Error ? error.message : "The source image could not be inspected"],
        });
    }).finally(() => { if (active) setAssessmentLoading(false); });
    return () => { active = false; };
  }, [effectiveExternalChromaKey, project.target.backgroundMode, sourceImage]);

  const setReferenceFromBlob = async (inputBlob: Blob, name: string, origin: ReferenceImageMetadata["origin"]) => {
    let blob: Blob;
    try { blob = await normalizeReferenceBlob(inputBlob); }
    catch (error) { setToast({ kind: "error", message: error instanceof Error ? error.message : "Reference image format is unsupported" }); return; }
    if (blob.size > maxReferenceSize) {
      setToast({ kind: "error", message: "Reference images must be 10MB or smaller." });
      return;
    }
    try {
      const dimensions = await inspectImage(blob);
      const metadata: ReferenceImageMetadata = {
        id: crypto.randomUUID(), name, mimeType: blob.type, size: blob.size,
        width: dimensions.width, height: dimensions.height, createdAt: new Date().toISOString(), origin,
      };
      const previous = project.referenceImage;
      const nextProject = { ...project, referenceImage: metadata, updatedAt: new Date().toISOString() };
      let persisted = false;
      try {
        await navigator.storage?.persist?.();
        await saveReferenceImage(project.id, metadata, blob);
        await saveProjectMetadata(nextProject);
        persisted = true;
        if (previous && previous.id !== metadata.id) await deleteReferenceImage(project.id, previous.id);
      } catch {
        // The reference remains usable in this session if OPFS is unavailable or full.
      }
      replaceReferenceImage({ blob, url: URL.createObjectURL(blob), metadata });
      setHistory((current) => commit(current, nextProject));
      setToast({
        kind: persisted ? "success" : "info",
        message: persisted ? "Reference image saved with this local project." : "Reference image is ready for this session, but persistent storage is unavailable.",
      });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Reference image could not be added" });
    }
  };

  const removeReference = async () => {
    if (!referenceImage) return;
    const referenceId = referenceImage.metadata.id;
    const nextProject = { ...project, referenceImage: undefined, updatedAt: new Date().toISOString() };
    replaceReferenceImage(null);
    setHistory((current) => commit(current, nextProject));
    try {
      await saveProjectMetadata(nextProject);
      await deleteReferenceImage(project.id, referenceId);
    } catch { /* The in-memory project is still cleared. */ }
    setToast({ kind: "success", message: "Reference image removed" });
  };

  const processStoredSourceImage = async (asset = sourceImage) => {
    if (!asset) { setToast({ kind: "info", message: "Upload an externally generated image first." }); return; }
    const success = await processImage(asset.url, asset.metadata.name, project.target.backgroundMode === "transparent" ? effectiveExternalChromaKey : undefined);
    if (success) { setProcessedSourceId(asset.metadata.id); setToast({ kind: "success", message: "External image processed with the current pixel settings." }); }
  };

  const acceptExternalImage = async (file?: File) => {
    if (!file) return;
    let blob: Blob;
    try { blob = await normalizeReferenceBlob(file); }
    catch (error) { setToast({ kind: "error", message: error instanceof Error ? error.message : "The source image format is unsupported" }); return; }
    if (blob.size > maxReferenceSize) { setToast({ kind: "error", message: "Source images must be 10MB or smaller." }); return; }
    try {
      const dimensions = await inspectImage(blob);
      const metadata: SourceImageMetadata = {
        id: crypto.randomUUID(), name: file.name || "external-image.png", mimeType: blob.type, size: blob.size,
        width: dimensions.width, height: dimensions.height, createdAt: new Date().toISOString(), origin: "external",
      };
      const previous = project.sourceImage;
      const nextProject = { ...project, sourceImage: metadata, target: { ...project.target, pixelSizeMode: "detected" as const }, updatedAt: new Date().toISOString() };
      let persisted = false;
      try {
        await navigator.storage?.persist?.();
        await saveSourceImage(project.id, metadata, blob);
        await saveProjectMetadata(nextProject);
        persisted = true;
        if (previous && previous.id !== metadata.id) await deleteSourceImage(project.id, previous.id);
      } catch { /* Keep the original in memory when OPFS is unavailable. */ }
      const asset = { blob, url: URL.createObjectURL(blob), metadata };
      replaceSourceImage(asset);
      if (project.target.backgroundMode === "transparent") {
        const assessment = validateExternalVideoReference(await imageDataFromBlob(blob), project.target.chromaKey);
        if (!assessment.pixelProcessingReady) setPixelationWarning({
          mediaKind: "image",
          chromaKey: project.target.chromaKey,
          reason: assessment.failures[0] || "The selected chroma background could not be removed safely.",
        });
      }
      setProcessedSourceId(undefined);
      setFitCanvas(true);
      setHistory((current) => commit(current, nextProject));
      setToast({ kind: persisted ? "success" : "info", message: persisted ? "Source image uploaded. Review the checks and processing options before continuing." : "Source image is ready for this session, but persistent storage is unavailable." });
    } catch (error) { setToast({ kind: "error", message: error instanceof Error ? error.message : "The external source image could not be added" }); }
  };

  const restartImage = async () => {
    const sourceImageId = sourceImage?.metadata.id;
    const nextProject = { ...project, mode: "image" as const, sourceImage: undefined, frames: [], updatedAt: new Date().toISOString() };
    replaceSourceImage(null);
    setSourceGridDetection(null);
    setProcessedSourceId(undefined);
    setVideoReferenceAssessment(null);
    setAssessmentLoading(false);
    setBusy(false);
    setProgress(0);
    setPlaying(false);
    setSelectedFrame(0);
    setFitCanvas(true);
    setHistory((current) => commit(current, nextProject));
    try {
      await saveProjectMetadata(nextProject);
      if (sourceImageId) await deleteSourceImage(project.id, sourceImageId);
    }
    catch { /* In-memory state is already safe. */ }
  };

  const updatePromptDraft = (kind: "image" | "video", patch: Partial<PixelProject["promptWorkflow"][typeof kind]>) => {
    updateProject((current) => ({
      ...current,
      promptWorkflow: {
        ...current.promptWorkflow,
        [kind]: { ...current.promptWorkflow[kind], ...patch },
      },
    }));
  };

  const invalidatePromptResults = (current: PixelProject) => ({
    ...current,
    promptWorkflow: {
      image: { ...current.promptWorkflow.image, generatedPrompt: undefined, generatedAt: undefined },
      video: { ...current.promptWorkflow.video, generatedPrompt: undefined, generatedAt: undefined },
    },
  });

  const generateLocalPrompt = async () => {
    if (!promptDraft.userText.trim()) {
      setToast({ kind: "info", message: promptKind === "image" ? "Describe the subject first." : "Describe the action first." });
      promptInputRef.current?.focus();
      return;
    }
    const result = generatePrompt(promptDraft.templateId, {
      kind: promptKind,
      userText: promptDraft.userText,
      backgroundMode: project.target.backgroundMode,
      chromaKey: project.target.chromaKey,
      imageSize: promptKind === "image" ? promptDraft.imageSize ?? DEFAULT_PROMPT_IMAGE_SIZE : undefined,
    });
    updateProject((current) => ({
      ...current,
      target: { ...current.target, chromaKey: result.chromaKey },
      promptWorkflow: {
        ...current.promptWorkflow,
        [promptKind]: {
          ...current.promptWorkflow[promptKind],
          templateId: result.template.id,
          generatedPrompt: result.prompt,
          generatedAt: new Date().toISOString(),
        },
      },
    }));
    try {
      await navigator.clipboard.writeText(result.prompt);
      setToast({ kind: "success", message: "Prompt generated and copied to the clipboard." });
    } catch {
      setToast({ kind: "info", message: "Prompt generated. Clipboard access was unavailable; use Copy again below." });
    }
  };

  const copyGeneratedPrompt = async () => {
    if (!promptDraft.generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(promptDraft.generatedPrompt);
      setToast({ kind: "success", message: "Prompt copied to the clipboard." });
    } catch {
      setToast({ kind: "error", message: "Clipboard access failed. Select and copy the prompt manually." });
    }
  };

  const referenceFromInternalDrag = async (payload: string) => {
    let parsed: { version?: number; source?: string; id?: string };
    try { parsed = JSON.parse(payload); }
    catch { throw new Error("This dragged item is not a Pixelate asset"); }
    if (parsed.version !== 1 || !parsed.id) throw new Error("This dragged item uses an unsupported Pixelate format");
    if (parsed.source === "project-frame") {
      const frame = project.frames.find((item) => item.id === parsed.id);
      if (!frame) throw new Error("The dragged canvas frame is no longer available");
      await setReferenceFromBlob(await composeVisibleFrame(frame, frame.width, frame.height), `${frame.name}.png`, "canvas");
      return;
    }
    if (parsed.source === "source-marker") {
      const marker = project.sourceSelection?.markers.find((candidate) => candidate.id === parsed.id);
      if (!sourceVideo || !marker || project.sourceSelection?.sourceVideoId !== sourceVideo.metadata.id) throw new Error("The selected source video frame is no longer available");
      setReferencePreparing(true);
      try {
        await setReferenceFromBlob(await captureVideoFrame(sourceVideo.url, marker.timeMs), `Source frame ${Math.round(marker.timeMs)}ms.png`, "canvas");
      } finally { setReferencePreparing(false); }
      return;
    }
    throw new Error("This dragged item is not a supported reference asset");
  };

  const onReferenceDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setReferenceDropActive(false);
    const file = [...event.dataTransfer.files].find((candidate) => !candidate.type || supportedReferenceTypes.has(candidate.type) || candidate.type === "image/jpg");
    try {
      if (file) await setReferenceFromBlob(file, file.name, "upload");
      else {
        const customPayload = event.dataTransfer.getData(referenceDragType);
        const fallback = event.dataTransfer.getData("text/plain");
        const payload = customPayload || (fallback.startsWith(referenceDragFallbackPrefix) ? fallback.slice(referenceDragFallbackPrefix.length) : "");
        if (!payload) throw new Error("Drop a PNG, JPEG, WebP, canvas frame or source-video frame here");
        await referenceFromInternalDrag(payload);
      }
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Reference drop failed" });
    }
  };

  const startReferenceDrag = (event: React.DragEvent, source: "project-frame" | "source-marker", id: string) => {
    event.dataTransfer.effectAllowed = "copy";
    const payload = JSON.stringify({ version: 1, source, id });
    event.dataTransfer.setData(referenceDragType, payload);
    event.dataTransfer.setData("text/plain", `${referenceDragFallbackPrefix}${payload}`);
  };

  const processSourceVideo = async (blob: Blob) => {
    const selection = project.sourceSelection;
    if (!sourceVideo || !selection || selection.sourceVideoId !== sourceVideo.metadata.id || !selection.markers.length) {
      setToast({ kind: "info", message: "Select at least one source frame before extraction." });
      return false;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setProgress(0); setPlaying(false);
    setFailedSourceMarkerIds([]);
    try {
      const file = new File([blob], sourceVideo?.metadata.name || "source-video.mp4", { type: blob.type || "video/mp4" });
      const markers = [...selection.markers].sort((a, b) => a.timeMs - b.timeMs);
      const frames = await extractVideoFrames(file, markers.map((marker) => marker.timeMs), project.target.fps, controller.signal, setProgress);
      controller.signal.throwIfAborted();
      // Video generation can introduce a different apparent lattice from the
      // still reference. Run the complete PerfectPixel detector again on the
      // first untouched frame and lock its Sobel-aligned grid across the animation.
      const gridDetection = detectPseudoPixelGrid(frames[0].imageData);
      setPendingFrames({ sourceVideoId: sourceVideo.metadata.id, frames, gridDetection, applied: false });
      setFrameOutputExpanded(true);
      if (gridDetection.detected) {
        updateProject((current) => ({
          ...current,
          target: { ...current.target, width: gridDetection.columns, height: gridDetection.rows, pixelSizeMode: "detected" },
        }));
      }
      setFrameOutputChoice("pixel-art");
      setOriginalExportSize(null);
      setOriginalFrameFitting("contain");
      setSelectedFrame(0); setFitCanvas(true); setWorkspaceView("video"); setToast({ kind: "success", message: `${frames.length} original frames extracted. Pixel-art frames are selected by default.` });
      return true;
    } catch (error) {
      setWorkspaceView("video");
      if (error instanceof VideoExtractionError) setFailedSourceMarkerIds(error.failedIndices.map((index) => selection.markers[index]?.id).filter(Boolean));
      if ((error as Error).name !== "AbortError") setToast({ kind: "error", message: error instanceof Error ? error.message : "Video extraction failed" });
      else setToast({ kind: "info", message: "Frame extraction cancelled; existing frames were kept." });
      return false;
    }
    finally { setBusy(false); if (abortRef.current === controller) abortRef.current = null; }
  };

  const keepOriginalFrames = async () => {
    if (!pendingFrames?.frames.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setProgress(0); setPlaying(false);
    try {
      const frames = await prepareOriginalFrames(pendingFrames.frames, originalExportSize, originalFrameFitting, project.target.fps, controller.signal, setProgress);
      updateProject((current) => ({ ...current, mode: "animation", frames }));
      setPendingFrames((current) => current ? { ...current, applied: true } : current); setSelectedFrame(0); setFitCanvas(true);
      setFrameOutputExpanded(false);
      setWorkspaceView("frames");
      setToast({ kind: "success", message: `${frames.length} original frames added to the timeline${originalExportSize === null ? " at source size" : " with smooth resizing"}.` });
    } catch (error) {
      if ((error as Error).name !== "AbortError") setToast({ kind: "error", message: error instanceof Error ? error.message : "Original frame preparation failed" });
      else setToast({ kind: "info", message: "Frame preparation cancelled; extracted preview and existing frames were kept." });
    } finally {
      setBusy(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const processPendingFrames = async () => {
    if (!pendingFrames?.frames.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setProgress(0); setFailedSourceMarkerIds([]); setPlaying(false);
    try {
      const frames = await pixelateExtractedFrames(pendingFrames.frames, project.target.width, project.target.height, project.target.fps, project.target.paletteSize, project.target.backgroundMode, project.target.chromaKey, pendingFrames.gridDetection, controller.signal, setProgress);
      updateProject((current) => ({ ...current, mode: "animation", frames }));
      setPendingFrames((current) => current ? { ...current, applied: true } : current); setSelectedFrame(0); setFitCanvas(true);
      setFrameOutputExpanded(false);
      setWorkspaceView("frames");
      setToast({ kind: "success", message: `${frames.length} frames processed with a shared pixel-art palette.` });
    } catch (error) {
      if (error instanceof VideoExtractionError) {
        const selection = project.sourceSelection;
        setFailedSourceMarkerIds(error.failedIndices.map((index) => selection?.markers[index]?.id).filter((id): id is string => Boolean(id)));
        if (project.target.backgroundMode === "transparent" && error.failedIndices.length) setPixelationWarning({
          mediaKind: "video",
          chromaKey: project.target.chromaKey,
          reason: error.message,
        });
      }
      if ((error as Error).name !== "AbortError") setToast({ kind: "error", message: error instanceof Error ? error.message : "Pixel processing failed" });
      else setToast({ kind: "info", message: "Pixel processing cancelled; extracted preview and existing frames were kept." });
    } finally { setBusy(false); if (abortRef.current === controller) abortRef.current = null; }
  };

  const discardPendingFrames = () => {
    setPendingFrames(null); setFrameOutputChoice(null); setFrameOutputExpanded(true); setSelectedFrame(0); setPlaying(false); setWorkspaceView("video");
    setToast({ kind: "info", message: "Extracted preview discarded. Your existing timeline was kept." });
  };

  const changePlaybackFps = (value: number) => {
    const fps = normalizePlaybackFps(value);
    const durationMs = Math.round(1000 / fps);
    setPendingFrames((current) => current ? {
      ...current,
      frames: current.frames.map((item) => ({ ...item, frame: { ...item.frame, durationMs } })),
    } : current);
    updateProject((current) => ({
      ...current,
      target: { ...current.target, fps },
      frames: current.frames.map((frame) => ({ ...frame, durationMs })),
    }));
  };

  const acceptSourceVideo = async (file?: File) => {
    if (!file) return;
    setPendingFrames(null); setFrameOutputChoice(null); setFrameOutputExpanded(true); setPlaying(false); setSelectedFrame(0);
    setOriginalExportSize(null); setOriginalFrameFitting("contain");
    const previous = project.sourceVideo;
    const id = crypto.randomUUID();
    const url = URL.createObjectURL(file);
    const preliminary: SourceVideoMetadata = {
      id, name: file.name || "source-video.mp4", mimeType: file.type || "video/mp4", size: file.size,
      duration: 0, width: 0, height: 0, createdAt: new Date().toISOString(), origin: "imported",
    };
    replaceSourceVideo({ blob: file, url, metadata: preliminary });
    setWorkspaceView("video");
    try {
      const details = await inspectVideo(url);
      const metadata = { ...preliminary, ...details };
      setSourceVideo((asset) => asset?.metadata.id === id ? { ...asset, metadata } : asset);
      const sourceSelection: SourceFrameSelection = { sourceVideoId: id, sourceFps: 24, extractFps: 1, rangeStartMs: 0, rangeEndMs: metadata.duration * 1000, playheadMs: 0, markers: [] };
      const nextProject: PixelProject = { ...project, mode: "animation", sourceVideo: metadata, sourceSelection, updatedAt: new Date().toISOString() };
      setHistory((current) => commit(current, nextProject));
      setFailedSourceMarkerIds([]);

      if (project.target.backgroundMode === "transparent") {
        void captureVideoFrame(url, 1).then(imageDataFromBlob).then((firstFrame) => {
          if (sourceVideoUrlRef.current !== url) return;
          const matte = removeChromaBackground(firstFrame, project.target.chromaKey);
          if (!matte.stats.success) setPixelationWarning({
            mediaKind: "video",
            chromaKey: project.target.chromaKey,
            reason: matte.stats.reason || "The first video frame does not have a removable chroma background.",
          });
        }).catch(() => {
          if (sourceVideoUrlRef.current === url) setPixelationWarning({
            mediaKind: "video",
            chromaKey: project.target.chromaKey,
            reason: "The first video frame could not be verified for safe chroma-background removal.",
          });
        });
      }

      let persisted = false;
      try {
        await navigator.storage?.persist?.();
        await saveSourceVideo(project.id, metadata, file);
        await saveProjectMetadata(nextProject);
        persisted = true;
        if (previous && previous.id !== metadata.id) await deleteSourceVideo(project.id, previous.id);
      } catch {
        // The in-memory player remains usable when OPFS is unavailable or full.
      }
      setToast({ kind: "success", message: persisted ? "Video ready. Select the source frames to extract." : "Video ready for frame selection, but it is available for this session only because persistent storage is unavailable." });
    } catch (error) {
      setWorkspaceView("video");
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Video import failed" });
    }
  };

  const restartVideo = async () => {
    const videoId = sourceVideo?.metadata.id;
    replaceSourceVideo(null);
    setPendingFrames(null); setFrameOutputChoice(null); setFrameOutputExpanded(true); setPlaying(false); setSelectedFrame(0);
    setFailedSourceMarkerIds([]);
    setOriginalExportSize(null); setOriginalFrameFitting("contain");
    setBusy(false); setProgress(0); setFitCanvas(true);
    setWorkspaceView("frames");
    const next: PixelProject = { ...project, mode: "animation", sourceVideo: undefined, sourceSelection: undefined, frames: [], updatedAt: new Date().toISOString() };
    setHistory((current) => commit(current, next));
    try {
      await saveProjectMetadata(next);
      if (videoId) await deleteSourceVideo(project.id, videoId);
    } catch { /* In-memory state is already safe. */ }
  };

  const editFrames = (fn: (frames: ProjectFrame[]) => ProjectFrame[]) => updateProject((current) => ({ ...current, frames: fn(current.frames) }));
  const deleteFrame = () => { if (project.frames.length <= 1) return; editFrames((frames) => frames.filter((_, index) => index !== selectedFrame)); setSelectedFrame((index) => Math.max(0, index - 1)); };
  const duplicateFrame = () => editFrames((frames) => { const copy = { ...frames[selectedFrame], id: crypto.randomUUID(), name: `${frames[selectedFrame].name} copy` }; return [...frames.slice(0, selectedFrame + 1), copy, ...frames.slice(selectedFrame + 1)]; });
  const mirrorFrame = () => editFrames((frames) => frames.map((frame, index) => index === selectedFrame ? { ...frame, mirrored: !frame.mirrored } : frame));

  const exportSheet = async () => {
    if (!project.frames.length) return;
    try {
      const { width, height } = frameSetDimensions(project.frames);
      const canvas = await composeSpriteSheet(project.frames, width, height, Math.min(8, project.frames.length));
      const sourceFilename = project.mode === "image" ? sourceImage?.metadata.name : sourceVideo?.metadata.name;
      const stem = exportNameStem(sourceFilename || project.name);
      const kind = project.mode === "animation" ? "-sheet" : "";
      downloadBlob(await canvasToBlob(canvas), `${stem}-${width}x${height}${kind}.png`);
      setToast({ kind: "success", message: "Sprite sheet exported" });
    } catch (error) { setToast({ kind: "error", message: error instanceof Error ? error.message : "Sprite sheet export failed" }); }
  };
  const switchMode = (mode: "image" | "animation") => {
    updateProject((current) => ({ ...current, mode }));
    setFitCanvas(true);
  };
  const openEditorMediaPicker = () => {
    if (project.mode === "image") sourceImageInputRef.current?.click();
    else videoRef.current?.click();
  };
  const acceptEditorMediaDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (project.mode === "image") void acceptExternalImage(file);
    else void acceptSourceVideo(file);
  };
  const imagePixelReady = project.target.backgroundMode === "opaque" || Boolean(videoReferenceAssessment?.pixelProcessingReady);
  const backgroundValue = project.target.backgroundMode === "opaque" ? "opaque" : `transparent:${project.target.chromaKey}`;
  const setBackgroundValue = (value: string) => updateProject((current) => ({
    ...invalidatePromptResults(current),
    target: {
      ...current.target,
      backgroundMode: value === "opaque" ? "opaque" : "transparent",
      chromaKey: value === "transparent:green" ? "green" : value === "transparent:magenta" ? "magenta" : current.target.chromaKey,
    },
  }));
  const targetGridDetection = project.mode === "animation" ? activePendingFrames?.gridDetection : sourceGridDetection;
  const detectedTarget = targetGridDetection?.detected
    ? { width: targetGridDetection.columns, height: targetGridDetection.rows, value: `detected:${targetGridDetection.columns}x${targetGridDetection.rows}` }
    : null;
  const targetMatchesDetection = Boolean(detectedTarget && project.target.pixelSizeMode === "detected" && project.target.width === detectedTarget.width && project.target.height === detectedTarget.height);
  const targetMatchesPreset = project.target.width === project.target.height && sizePresets.includes(project.target.width);
  const targetPixelSizeValue = targetMatchesDetection
    ? detectedTarget!.value
    : targetMatchesPreset
      ? String(project.target.width)
      : `custom:${project.target.width}x${project.target.height}`;
  const targetPixelSizeOptions = <>
    {detectedTarget && <option value={detectedTarget.value}>Detected grid — {detectedTarget.width} × {detectedTarget.height} px</option>}
    {!targetMatchesDetection && !targetMatchesPreset && <option value={targetPixelSizeValue}>Current — {project.target.width} × {project.target.height} px</option>}
    {sizePresets.map((size) => <option key={size} value={size}>{size} × {size} px</option>)}
  </>;
  const setTargetPixelSize = (value: string) => {
    const detectedMatch = /^detected:(\d+)x(\d+)$/.exec(value);
    const customMatch = /^custom:(\d+)x(\d+)$/.exec(value);
    const width = detectedMatch ? Number(detectedMatch[1]) : customMatch ? Number(customMatch[1]) : Number(value);
    const height = detectedMatch ? Number(detectedMatch[2]) : customMatch ? Number(customMatch[2]) : width;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    updateProject((current) => ({ ...current, target: { ...current.target, width, height, pixelSizeMode: detectedMatch ? "detected" : "manual" } }));
  };
  const processingControls = () => <div className="external-processing-options">
    <div className="processing-control-grid">
      <label>Target pixel size<select aria-label="Target pixel size" value={targetPixelSizeValue} onChange={(event) => setTargetPixelSize(event.target.value)}>{targetPixelSizeOptions}</select></label>
      <label>Palette<select value={project.target.paletteSize} onChange={(event) => updateProject((current) => ({ ...current, target: { ...current.target, paletteSize: Number(event.target.value) } }))}><option value="8">8 colors</option><option value="16">16 colors</option><option value="24">24 colors</option><option value="32">32 colors</option><option value="64">64 colors</option></select></label>
      <label className="background-control">Background<select value={backgroundValue} onChange={(event) => setBackgroundValue(event.target.value)}><option value="transparent:magenta">Transparent — Magenta key</option><option value="transparent:green">Transparent — Green key</option><option value="opaque">Keep generated background</option></select></label>
    </div>
  </div>;
  const frameOutputPanel = activePendingFrames ? <section className={`frame-output-panel ${frameOutputChoice ? "with-settings" : ""} ${activePendingFrames.applied ? "is-applied" : ""} ${frameOutputExpanded ? "is-expanded" : "is-collapsed"}`} aria-label="Extracted frame output">
    <div className="frame-output-heading">
      <div><span className="workbench-eyebrow">EXTRACTED FRAMES</span><strong>{activePendingFrames.applied ? "Frame output applied" : "Choose frame output"}</strong></div>
      <span title={activePendingFrames.gridDetection.detected ? undefined : "PerfectPixel could not detect a pixel grid from the first extracted frame"}>{activePendingFrames.frames.length} frames · {activePendingFrames.frames[0]?.frame.width} × {activePendingFrames.frames[0]?.frame.height} · {project.sourceSelection?.extractFps ?? 1} FPS · {activePendingFrames.gridDetection.detected ? `Target ${activePendingFrames.gridDetection.columns} × ${activePendingFrames.gridDetection.rows} px · PerfectPixel` : "Grid not detected"}</span>
      <IconButton label={frameOutputExpanded ? "Collapse extracted frames panel" : "Expand extracted frames panel"} onClick={() => setFrameOutputExpanded((expanded) => !expanded)}>{frameOutputExpanded ? <CaretDown /> : <CaretUp />}</IconButton>
    </div>
    <div className="frame-output-drawer" aria-hidden={!frameOutputExpanded}>
      <div className="frame-output-drawer-inner">
        <div className="frame-output-main">
          <div className="frame-output-mode">
            <label>Output method<select aria-label="Output method" value={frameOutputChoice ?? "pixel-art"} onChange={(event) => setFrameOutputChoice(event.target.value as "original" | "pixel-art")}><option value="original">Original frames</option><option value="pixel-art">Pixel-art frames</option></select></label>
          </div>
          <div className="frame-output-apply">
            <div className="frame-output-actions"><button className="discard-preview" onClick={discardPendingFrames} disabled={busy}>Discard extraction</button><button className="generate-button" onClick={() => { if (frameOutputChoice === "original") void keepOriginalFrames(); else if (frameOutputChoice === "pixel-art") void processPendingFrames(); }} disabled={busy || !frameOutputChoice}>{busy ? "Processing…" : !frameOutputChoice ? "Choose output method" : frameOutputChoice === "pixel-art" ? activePendingFrames.applied ? "Re-pixelate frames" : "Pixelate and use frames" : activePendingFrames.applied ? "Apply original frames" : "Use original frames"}</button></div>
          </div>
        </div>
        {frameOutputChoice === "original" && <div className="frame-output-processing">
          <span className="frame-output-processing-label">Original settings</span>
          <label>Export size<select aria-label="Original frame export size" value={originalExportSize ?? "source"} onChange={(event) => setOriginalExportSize(event.target.value === "source" ? null : Number(event.target.value))}><option value="source">Source size</option>{sizePresets.map((size) => <option key={size} value={size}>{size}px</option>)}</select></label>
          {originalExportSize !== null && <label>Frame fitting<select aria-label="Original frame fitting" value={originalFrameFitting} onChange={(event) => setOriginalFrameFitting(event.target.value as OriginalFrameFitting)}><option value="contain">Keep aspect ratio</option><option value="crop">Center crop to square</option><option value="stretch">Stretch to square</option></select></label>}
        </div>}
        {frameOutputChoice === "pixel-art" && <div className="frame-output-processing">
          <span className="frame-output-processing-label">Pixel-art settings</span>
          <label>Size<select aria-label="Pixel-art output size" value={targetPixelSizeValue} onChange={(event) => setTargetPixelSize(event.target.value)}>{targetPixelSizeOptions}</select></label>
          <label>Palette<select value={project.target.paletteSize} onChange={(event) => updateProject((current) => ({ ...current, target: { ...current.target, paletteSize: Number(event.target.value) } }))}><option value="8">8 colors</option><option value="16">16 colors</option><option value="24">24 colors</option><option value="32">32 colors</option><option value="64">64 colors</option></select></label>
          <label>Background<select value={backgroundValue} onChange={(event) => setBackgroundValue(event.target.value)}><option value="transparent:magenta">Magenta key</option><option value="transparent:green">Green key</option><option value="opaque">Keep background</option></select></label>
        </div>}
      </div>
    </div>
  </section> : null;
  return (
    <div className="app-shell">
      <header className="topbar">
        <AppLogo />
        <nav aria-label="Primary navigation">
          <button className={`nav-item ${project.mode === "image" ? "active" : ""}`} onClick={() => switchMode("image")}><ImageSquare /> Pixel image</button>
          <button className={`nav-item ${project.mode === "animation" ? "active" : ""}`} onClick={() => switchMode("animation")}><FilmStrip /> Animation</button>
        </nav>
        <div className="top-actions">
          <GitHubStarPill />
        </div>
      </header>
      <input ref={sourceImageInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void acceptExternalImage(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      <input ref={videoRef} hidden type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(event) => { void acceptSourceVideo(event.target.files?.[0]); event.currentTarget.value = ""; }} />

      <main className="workspace">
        <aside className="left-panel panel-scroll">
          <div className="panel-heading"><div><span className="eyebrow">WORKFLOW</span><h1>{project.mode === "image" ? "Create pixel image" : "Animate a sprite"}</h1></div></div>
          <div className="external-guide">
            <section className="external-step">
              <div className="prompt-section-heading"><strong>Build prompt</strong><small>Choose a template, describe the {project.mode === "image" ? "subject" : "action"}, then generate and copy the complete prompt.</small></div>
              <label className="prompt-template-choice">Prompt template<select value={activePromptTemplate?.id || ""} onChange={(event) => updatePromptDraft(promptKind, { templateId: event.target.value, generatedPrompt: undefined, generatedAt: undefined })}>{availablePromptTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select><small>{activePromptTemplate?.description}</small></label>
              {promptKind === "image" && <label className="prompt-size-choice">Prompt size<select value={promptDraft.imageSize ?? DEFAULT_PROMPT_IMAGE_SIZE} onChange={(event) => updatePromptDraft("image", { imageSize: Number(event.target.value) as PromptImageSize, generatedPrompt: undefined, generatedAt: undefined })}>{PROMPT_IMAGE_SIZES.map((size) => <option key={size} value={size}>{size} × {size}</option>)}</select><small>Sets the native pixel-art dimensions requested from the image model.</small></label>}
              <label className="prompt-input-label" htmlFor={`${promptKind}-prompt-input`}>{activePromptTemplate?.inputLabel}</label>
              <textarea
                ref={promptInputRef}
                id={`${promptKind}-prompt-input`}
                className="prompt-builder-input"
                value={promptDraft.userText}
                placeholder={activePromptTemplate?.inputPlaceholder}
                onChange={(event) => updatePromptDraft(promptKind, { userText: event.target.value, generatedPrompt: undefined, generatedAt: undefined })}
              />
              <label className="external-background-choice">Background requirement<select value={backgroundValue} onChange={(event) => setBackgroundValue(event.target.value)}><option value="transparent:magenta">Magenta #FF00FF</option><option value="transparent:green">Green #00FF00</option><option value="opaque">Keep generated background · static only</option></select></label>
              <button className="copy-prompt-button" onClick={() => { void generateLocalPrompt(); }}><Sparkle weight="fill" /> Generate prompt</button>
              {promptDraft.generatedPrompt && <div className="generated-prompt"><div><strong>Complete prompt</strong><span>Generated {promptDraft.generatedAt ? new Date(promptDraft.generatedAt).toLocaleString() : "just now"}</span></div><div className="prompt-editor"><textarea className="prompt-preview" readOnly value={promptDraft.generatedPrompt} aria-label="Generated prompt" /><button className="prompt-copy-icon" aria-label="Copy prompt" title="Copy prompt" onClick={() => { void copyGeneratedPrompt(); }}><Copy /></button></div></div>}
            </section>

          </div>
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            {project.mode === "image"
              ? <div className="toolbar-group">
                <IconButton label="Download image" onClick={() => { if (currentFrame) { void exportSheet(); } else if (sourceImage) { downloadBlob(sourceImage.blob, sourceImage.metadata.name); } }} disabled={!currentFrame && !sourceImage}><DownloadSimple /></IconButton>
                <IconButton label="Restart image" onClick={() => { void restartImage(); }} disabled={!sourceImage && !currentFrame}><ArrowCounterClockwise /></IconButton>
              </div>
              : <div className="toolbar-group">
                <IconButton label={sourceVideoViewActive ? "Download source video" : "Download sprite sheet"} onClick={() => { if (sourceVideoViewActive && sourceVideo) { downloadBlob(sourceVideo.blob, sourceVideo.metadata.name); } else { void exportSheet(); } }} disabled={sourceVideoViewActive ? !sourceVideo : pendingFramePreview || !project.frames.length}><DownloadSimple /></IconButton>
                <IconButton label="Restart animation" onClick={() => { void restartVideo(); }} disabled={!sourceVideo && !project.frames.length && !activePendingFrames}><ArrowCounterClockwise /></IconButton>
              </div>}
            <div className="toolbar-group" />
            <div className="toolbar-group">{!sourceVideoViewActive && <div className="zoom-control" role="group" aria-label="Canvas zoom"><button aria-label="Zoom out" title="Zoom out" onClick={() => { setFitCanvas(false); setZoom(zoomOut(effectiveZoom)); }} disabled={effectiveZoom <= minZoom}><Minus /></button><output aria-live="polite">{Math.round(effectiveZoom * 100)}%</output><button aria-label="Zoom in" title="Zoom in" onClick={() => { setFitCanvas(false); setZoom(zoomIn(effectiveZoom)); }} disabled={effectiveZoom >= maxZoom}><Plus /></button><button className={fitCanvas ? "fit-selected" : ""} aria-label="Fit canvas" title="Fit canvas" onClick={() => setFitCanvas(true)}>Fit</button></div>}</div>
          </div>
          <div ref={canvasStageRef} className={`canvas-stage ${workspaceView === "video" ? "video-stage" : ""}`}>
            {project.mode === "animation" && workspaceView === "video" && sourceVideo ? <>
              <div className="canvas-meta"><span>SOURCE VIDEO</span><span>{sourceVideo.metadata.width || "—"} × {sourceVideo.metadata.height || "—"}</span></div>
              <div className="source-video-shell">
                <SourceFramePicker
                  asset={sourceVideo}
                  selection={project.sourceSelection && project.sourceSelection.sourceVideoId === sourceVideo.metadata.id ? project.sourceSelection : { sourceVideoId: sourceVideo.metadata.id, sourceFps: 24, extractFps: 1, rangeStartMs: 0, rangeEndMs: sourceVideo.metadata.duration * 1000, playheadMs: 0, markers: [] }}
                  extractFps={project.sourceSelection?.extractFps ?? 1}
                  playbackFps={project.target.fps}
                  backgroundMode={project.target.backgroundMode}
                  chromaKey={project.target.chromaKey}
                  busy={busy}
                  failedMarkerIds={failedSourceMarkerIds}
                  onChange={(sourceSelection) => {
                    const previous = project.sourceSelection;
                    const selectionChanged = previous?.sourceFps !== sourceSelection.sourceFps
                      || previous?.rangeStartMs !== sourceSelection.rangeStartMs
                      || previous?.rangeEndMs !== sourceSelection.rangeEndMs
                      || previous?.markers.map((marker) => `${marker.id}:${marker.timeMs}`).join("|") !== sourceSelection.markers.map((marker) => `${marker.id}:${marker.timeMs}`).join("|");
                    if (selectionChanged) { setPendingFrames(null); setFrameOutputChoice(null); }
                    updateProject((current) => ({ ...current, sourceSelection }));
                  }}
                  onExtractFpsChange={(fps) => {
                    setPendingFrames(null); setFrameOutputChoice(null);
                    updateProject((current) => ({ ...current, sourceSelection: current.sourceSelection ? { ...current.sourceSelection, extractFps: fps } : current.sourceSelection }));
                  }}
                  onExtract={() => { void processSourceVideo(sourceVideo.blob); }}
                  onCancel={() => abortRef.current?.abort()}
                  onReferenceDragStart={(event, markerId) => startReferenceDrag(event, "source-marker", markerId)}
                  hasPendingOutput={Boolean(activePendingFrames)}
                />
              </div>
            </> : <div className="canvas-scroll-content">
              <div className="canvas-meta"><span>{project.mode === "image" ? sourceImage && !currentFrame ? "SOURCE IMAGE" : "PIXEL PREVIEW" : pendingFramePreview ? `EXTRACTED PREVIEW · FRAME ${selectedFrame + 1} OF ${displayedFrames.length}` : `FRAME ${selectedFrame + 1} OF ${displayedFrames.length}`}</span><span>{currentFrame ? `${currentFrameWidth} × ${currentFrameHeight} · ${pendingFramePreview ? "not yet applied" : currentFrame.processing === "original" ? "original frames" : `${project.target.paletteSize} colors`}` : sourceImage && project.mode === "image" ? `${sourceImage.metadata.width} × ${sourceImage.metadata.height} · awaiting processing` : ""}</span></div>
              <div className={`checkerboard ${!currentFrame ? "editor-media-target" : ""}`} style={previewSize} draggable={Boolean(currentFrame && !pendingFramePreview)} onDragStart={(event) => currentFrame && !pendingFramePreview && startReferenceDrag(event, "project-frame", currentFrame.id)} onDragOver={!currentFrame ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } : undefined} onDrop={!currentFrame ? acceptEditorMediaDrop : undefined} title={currentFrame && !pendingFramePreview ? "Drag this frame to the Reference area" : undefined}>
                {currentFrame ? <img draggable={false} src={currentFrame.dataUrl} className={currentFrame.mirrored ? "mirrored" : ""} style={{ transform: `translate(${currentFrame.offsetX * effectiveZoom}px, ${currentFrame.offsetY * effectiveZoom}px) ${currentFrame.mirrored ? "scaleX(-1)" : ""}` }} alt={`Current sprite ${currentFrame.name}`} /> : project.mode === "image" && sourceImage ? <img draggable={false} src={sourceImage.url} className="source-media-preview" alt={`Source image ${sourceImage.metadata.name}`} /> : project.mode === "animation" && sourceVideo ? <div className="empty-canvas"><FilmStrip /><span>Select source video frames to create the animation</span></div> : <button className="editor-media-upload" onClick={openEditorMediaPicker}><UploadSimple /><strong>{project.mode === "image" ? "Upload image" : "Upload video"}</strong><span>{project.mode === "image" ? "PNG, JPEG or WebP · max 10MB" : "MP4, WebM or MOV · processed locally"}</span></button>}
              </div>
            </div>}
          </div>

          {project.mode === "image" && sourceImage && <section className="image-workbench-panel compact-image-workbench" aria-label="Image processing controls">
            <div className="compact-image-controls">
              <div className="compact-grid-detection">
                <span className="workbench-eyebrow">DETECTED RESOLUTION</span>
                <strong className={sourceGridDetection?.detected ? "detected" : ""} title="PerfectPixel uses FFT first, Sobel-gradient fallback when needed, and Sobel-aligned grid boundaries."><GridFour /> {assessmentLoading ? "Detecting…" : sourceGridDetection?.detected ? `${sourceGridDetection.columns} × ${sourceGridDetection.rows} px` : "Not detected"}</strong>
              </div>

              <div className="compact-processing-controls">{processingControls()}</div>

              <div className="compact-image-actions">
                <div className="compact-primary-actions">
                  <button className="generate-button" disabled={assessmentLoading || !imagePixelReady} onClick={() => { void processStoredSourceImage(); }}><MagicWand /> {processedSourceId === sourceImage.metadata.id ? "Reprocess image" : "Process image"}</button>
                </div>
              </div>
            </div>
          </section>}

          {project.mode === "animation" && (activePendingFrames || displayedFrames.length > 0) && <div className={`animation-bottom-panel ${activePendingFrames && !frameOutputExpanded ? "extracted-panels-collapsed" : ""}`}>
            {activePendingFrames && frameOutputPanel}
            {displayedFrames.length > 0 && <div className={`timeline-panel ${pendingFramePreview ? "pending-preview" : ""}`}>
              <div className="timeline-header">
                <div className="playback"><IconButton label={playing ? "Pause animation" : "Play animation"} onClick={() => { setWorkspaceView("frames"); setPlaying((value) => !value); }} disabled={!displayedFrames.length}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</IconButton><label className="playback-fps">Playback FPS<input aria-label="Playback FPS" type="number" min="1" max="60" step="1" value={project.target.fps} onChange={(event) => changePlaybackFps(Number(event.target.value))} /></label><span>{(displayedFrames.length / project.target.fps).toFixed(1)}s</span>{pendingFramePreview && <span className="pending-label">Extracted preview · not yet applied</span>}</div>
                <div className="frame-actions"><IconButton label="Duplicate frame" onClick={duplicateFrame} disabled={pendingFramePreview}><Copy /></IconButton><IconButton label="Mirror frame" onClick={mirrorFrame} disabled={pendingFramePreview}><SelectionBackground /></IconButton><IconButton label="Delete frame" onClick={deleteFrame} disabled={pendingFramePreview || project.frames.length <= 1}><Trash /></IconButton></div>
              </div>
              <div className="timeline-strip">
                {sourceVideo && <button className={`frame-thumb source-video-thumb ${workspaceView === "video" ? "selected" : ""}`} title="Show source video" aria-label="Show source video" onClick={() => { setPlaying(false); setWorkspaceView("video"); }}><span>Video</span><FilmStrip /></button>}
                {displayedFrames.map((frame, index) => <button key={frame.id} draggable={!pendingFramePreview} onDragStart={(event) => !pendingFramePreview && startReferenceDrag(event, "project-frame", frame.id)} title={pendingFramePreview ? "Show extracted frame" : "Select frame, or drag to Reference"} className={`frame-thumb ${workspaceView === "frames" && index === selectedFrame ? "selected" : ""}`} onClick={() => { setSelectedFrame(index); setWorkspaceView("frames"); setFitCanvas(true); }}><span>{index + 1}</span><img draggable={false} src={frame.dataUrl} alt="" />{frame.warnings.length > 0 && <WarningCircle className="warning" />}</button>)}
              </div>
            </div>}
          </div>}
        </section>

      </main>

      {pixelationWarning && <div className="pixelation-warning-backdrop" onMouseDown={() => setPixelationWarning(null)}>
        <section className="pixelation-warning-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pixelation-warning-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="pixelation-warning-icon"><WarningCircle weight="fill" /></div>
          <div className="pixelation-warning-copy">
            <span>PIXELATION REQUIREMENT</span>
            <h2 id="pixelation-warning-title">Background is not ready for transparent pixelation</h2>
            <p>The uploaded {pixelationWarning.mediaKind} does not pass the selected {pixelationWarning.chromaKey === "magenta" ? "magenta #FF00FF" : "green #00FF00"} background check.</p>
            <div className="pixelation-warning-reason">{pixelationWarning.reason}</div>
            <p>Use a solid, uniform chroma background that does not appear in the subject. Every selected video frame must pass this check. Alternatively, keep the background and pixelate the entire frame.</p>
          </div>
          <div className="pixelation-warning-actions">
            <button className="warning-secondary" onClick={() => { setBackgroundValue("opaque"); setPixelationWarning(null); }}>Keep background</button>
            <button className="warning-primary" autoFocus onClick={() => setPixelationWarning(null)}>Got it</button>
          </div>
        </section>
      </div>}

    </div>
  );
}
