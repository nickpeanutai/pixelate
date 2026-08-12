import type { SourceFrameMarker } from "@pixel-sprite/project-schema";

export const MAX_SOURCE_MARKERS = 240;

export function normalizeExtractFps(value: number) {
  return Number.isFinite(value) ? Math.min(24, Math.max(1, Math.round(value))) : 1;
}

export function normalizePlaybackFps(value: number) {
  return Number.isFinite(value) ? Math.min(60, Math.max(1, Math.round(value))) : 1;
}

export function automaticMarkerCount(durationMs: number, extractFps: number) {
  return Math.max(1, Math.floor(Math.max(0, durationMs) / 1000 * normalizeExtractFps(extractFps)));
}

export function normalizeSourceFps(value: number) {
  return Number.isFinite(value) ? Math.min(120, Math.max(1, value)) : 24;
}

export function sourceFrameCount(durationMs: number, sourceFps: number) {
  return Math.max(1, Math.floor(Math.max(0, durationMs) / 1000 * normalizeSourceFps(sourceFps)));
}

export function frameIndexAtTime(timeMs: number, sourceFps: number, durationMs: number) {
  const total = sourceFrameCount(durationMs, sourceFps);
  return Math.min(total - 1, Math.max(0, Math.round(Math.max(0, timeMs) / 1000 * normalizeSourceFps(sourceFps))));
}

export function timeForSourceFrame(frameIndex: number, sourceFps: number, durationMs: number) {
  const total = sourceFrameCount(durationMs, sourceFps);
  const index = Math.min(total - 1, Math.max(0, Math.round(frameIndex)));
  return Math.min(Math.max(0, durationMs - 1), Number((index / normalizeSourceFps(sourceFps) * 1000).toFixed(3)));
}

export function snapSourceTime(timeMs: number, sourceFps: number, durationMs: number) {
  return timeForSourceFrame(frameIndexAtTime(timeMs, sourceFps, durationMs), sourceFps, durationMs);
}

export function addSourceMarker(markers: SourceFrameMarker[], timeMs: number, sourceFps: number, durationMs: number, id = crypto.randomUUID(), rangeStartMs = 0, rangeEndMs = durationMs) {
  if (markers.length >= MAX_SOURCE_MARKERS) return markers;
  const upperBound = Math.max(rangeStartMs, Math.min(durationMs - 1, rangeEndMs - 1));
  const snapped = snapSourceTime(Math.min(upperBound, Math.max(rangeStartMs, timeMs)), sourceFps, durationMs);
  const frameIndex = frameIndexAtTime(snapped, sourceFps, durationMs);
  if (markers.some((marker) => frameIndexAtTime(marker.timeMs, sourceFps, durationMs) === frameIndex)) return markers;
  return [...markers, { id, timeMs: snapped }].sort((a, b) => a.timeMs - b.timeMs);
}

export function moveSourceMarker(markers: SourceFrameMarker[], id: string, timeMs: number, sourceFps: number, durationMs: number, rangeStartMs = 0, rangeEndMs = durationMs) {
  const index = markers.findIndex((marker) => marker.id === id);
  if (index < 0) return markers;
  const step = 1000 / normalizeSourceFps(sourceFps);
  const minimum = index > 0 ? markers[index - 1].timeMs + step : rangeStartMs;
  const maximum = index < markers.length - 1 ? markers[index + 1].timeMs - step : Math.max(rangeStartMs, Math.min(durationMs - 1, rangeEndMs - 1));
  const nextTime = snapSourceTime(Math.min(maximum, Math.max(minimum, timeMs)), sourceFps, durationMs);
  return markers.map((marker) => marker.id === id ? { ...marker, timeMs: nextTime } : marker).sort((a, b) => a.timeMs - b.timeMs);
}

export function createAutomaticMarkers(durationMs: number, outputFps: number, sourceFps = 24, rangeStartMs = 0, rangeEndMs = durationMs) {
  const fps = normalizeExtractFps(outputFps);
  const start = Math.min(Math.max(0, rangeStartMs), Math.max(0, durationMs - 1));
  const end = Math.min(durationMs, Math.max(start + 1, rangeEndMs));
  const count = automaticMarkerCount(end - start, fps);
  if (count > MAX_SOURCE_MARKERS) throw new Error(`This selection would create ${count} frames. Lower Extract FPS to stay within ${MAX_SOURCE_MARKERS} frames.`);
  return Array.from({ length: count }, (_, index) => start + index / fps * 1000)
    .reduce<SourceFrameMarker[]>((markers, timeMs) => addSourceMarker(markers, timeMs, sourceFps, durationMs, crypto.randomUUID(), start, end), []);
}
