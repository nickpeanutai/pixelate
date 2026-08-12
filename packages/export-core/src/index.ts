import JSZip from "jszip";
import type { PixelProject, ProjectFrame } from "@pixel-sprite/project-schema";

export function dataUrlToBlob(dataUrl: string) {
  const [meta, content] = dataUrl.split(",");
  const bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: meta.match(/data:(.*?);/)?.[1] || "image/png" });
}

export function frameSetDimensions(frames: ProjectFrame[]) {
  if (!frames.length) throw new Error("There are no frames to export");
  const { width, height } = frames[0];
  if (!width || !height || frames.some((frame) => frame.width !== width || frame.height !== height)) {
    throw new Error("All animation frames must have the same dimensions before export");
  }
  return { width, height };
}

export async function composeSpriteSheet(frames: ProjectFrame[], width: number, height: number, columns = frames.length) {
  const safeColumns = Math.max(1, Math.min(columns, frames.length || 1));
  const rows = Math.ceil(frames.length / safeColumns);
  const canvas = document.createElement("canvas");
  canvas.width = width * safeColumns; canvas.height = height * Math.max(1, rows);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  await Promise.all(frames.map(async (frame, index) => {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Frame decode failed")); image.src = frame.dataUrl; });
    context.save();
    const x = (index % safeColumns) * width;
    const y = Math.floor(index / safeColumns) * height;
    context.translate(frame.mirrored ? x + width : x, y);
    context.scale(frame.mirrored ? -1 : 1, 1);
    context.drawImage(image, frame.offsetX, frame.offsetY, width, height);
    context.restore();
  }));
  return canvas;
}

export function buildManifest(project: PixelProject, columns: number) {
  const { width, height } = frameSetDimensions(project.frames);
  return {
    version: "1.0",
    image: "sprite-sheet.png",
    frameSize: { w: width, h: height },
    fps: project.target.fps,
    loop: project.target.loop,
    frames: project.frames.map((frame, index) => ({ filename: `${String(index).padStart(3, "0")}.png`, frame: { x: (index % columns) * width, y: Math.floor(index / columns) * height, w: width, h: height }, duration: frame.durationMs })),
  };
}

export async function exportAssetBundle(project: PixelProject, columns = Math.min(8, project.frames.length || 1)) {
  const zip = new JSZip();
  const { width, height } = frameSetDimensions(project.frames);
  const sheet = await composeSpriteSheet(project.frames, width, height, columns);
  const sheetBlob = await new Promise<Blob>((resolve) => sheet.toBlob((blob) => resolve(blob!), "image/png"));
  zip.file("sprite-sheet.png", sheetBlob);
  const framesFolder = zip.folder("frames")!;
  project.frames.forEach((frame, index) => framesFolder.file(`${String(index).padStart(3, "0")}.png`, dataUrlToBlob(frame.dataUrl)));
  const manifest = buildManifest(project, columns);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("sprite-sheet.json", JSON.stringify({ frames: Object.fromEntries(manifest.frames.map((frame) => [frame.filename, { frame: frame.frame, duration: frame.duration }])), meta: { image: "sprite-sheet.png", format: "RGBA8888", size: { w: sheet.width, h: sheet.height }, scale: "1" } }, null, 2));
  zip.file("project.json", JSON.stringify(project, null, 2));
  return zip.generateAsync({ type: "blob" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function framePixels(frame: ProjectFrame, width: number, height: number) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!; context.imageSmoothingEnabled = false;
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Frame decode failed")); image.src = frame.dataUrl; });
  context.translate(frame.mirrored ? width : 0, 0); context.scale(frame.mirrored ? -1 : 1, 1);
  context.drawImage(image, frame.offsetX, frame.offsetY, width, height);
  return context.getImageData(0, 0, width, height);
}

export async function encodeGif(frames: ProjectFrame[], width: number, height: number, fps: number) {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const images = await Promise.all(frames.map((frame) => framePixels(frame, width, height)));
  const palette = quantize(images[0].data, 256, { format: "rgba4444", oneBitAlpha: true });
  const encoder = GIFEncoder();
  images.forEach((image, index) => encoder.writeFrame(applyPalette(image.data, palette, "rgba4444"), width, height, { palette, delay: Math.round(1000 / fps), repeat: index === 0 ? 0 : undefined, transparent: true }));
  encoder.finish();
  const bytes = new Uint8Array(encoder.bytes());
  return new Blob([bytes.slice().buffer], { type: "image/gif" });
}

export async function encodeApng(frames: ProjectFrame[], width: number, height: number, fps: number) {
  const UPNG = (await import("upng-js")).default;
  const images = await Promise.all(frames.map((frame) => framePixels(frame, width, height)));
  const buffers = images.map((image) => image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength));
  const result = UPNG.encode(buffers, width, height, 0, frames.map(() => Math.round(1000 / fps)));
  return new Blob([result], { type: "image/apng" });
}
