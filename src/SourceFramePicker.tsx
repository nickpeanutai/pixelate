import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, FilmStrip, Pause, Play, Plus, X,
} from "@phosphor-icons/react";
import { removeChromaBackground, type ChromaKeyName } from "@pixel-sprite/pixel-core";
import type { SourceFrameMarker, SourceFrameSelection, SourceVideoMetadata } from "@pixel-sprite/project-schema";
import {
  MAX_SOURCE_MARKERS, addSourceMarker, automaticMarkerCount, createAutomaticMarkers, frameIndexAtTime,
  moveSourceMarker, normalizeExtractFps, normalizeSourceFps, sourceFrameCount, timeForSourceFrame,
} from "./frame-picker";

type Thumbnail = { dataUrl: string; playbackDataUrl: string; timeMs: number; error?: string };
type FrameAnalysis = { cacheKey: string; warning?: string };

interface SourceFramePickerProps {
  asset: { blob: Blob; url: string; metadata: SourceVideoMetadata };
  selection: SourceFrameSelection;
  extractFps: number;
  playbackFps: number;
  backgroundMode: "transparent" | "opaque";
  chromaKey: ChromaKeyName;
  busy: boolean;
  failedMarkerIds: string[];
  onChange: (selection: SourceFrameSelection) => void;
  onExtractFpsChange: (fps: number) => void;
  onExtract: () => void;
  onCancel: () => void;
  onReferenceDragStart: (event: React.DragEvent, markerId: string) => void;
  hasPendingOutput?: boolean;
}

const formatTime = (timeMs: number) => `${(timeMs / 1000).toFixed(3)}s`;

async function waitForMetadata(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("Video metadata could not be decoded")), { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, timeMs: number) {
  await waitForMetadata(video);
  const target = Math.min(Math.max(0, timeMs / 1000), Math.max(0, video.duration - 0.001));
  if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError); };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("The selected video frame could not be decoded")); };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = target;
  });
  if ("requestVideoFrameCallback" in video) {
    await Promise.race([
      new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())),
      new Promise<void>((resolve) => window.setTimeout(resolve, 120)),
    ]);
  }
}

export function SourceFramePicker({
  asset, selection, extractFps, playbackFps, backgroundMode, chromaKey, busy, failedMarkerIds,
  onChange, onExtractFpsChange, onExtract, onCancel, onReferenceDragStart,
  hasPendingOutput = false,
}: SourceFramePickerProps) {
  const durationMs = Math.max(1, asset.metadata.duration * 1000);
  const totalFrames = sourceFrameCount(durationMs, selection.sourceFps);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragIdRef = useRef<string | null>(null);
  const rangeDragRef = useRef<"start" | "end" | null>(null);
  const rangeValueRef = useRef<{ startMs: number; endMs: number } | null>(null);
  const dragTimeRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const thumbnailsRef = useRef<Map<string, Thumbnail>>(new Map());
  const analysesRef = useRef<Map<string, FrameAnalysis>>(new Map());
  const [playheadMs, setPlayheadMs] = useState(selection.playheadMs);
  const [selectedId, setSelectedId] = useState<string | null>(selection.markers[0]?.id ?? null);
  const [dragTimeMs, setDragTimeMs] = useState<number | null>(null);
  const [dragRange, setDragRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<string, Thumbnail>>(() => new Map());
  const [analyses, setAnalyses] = useState<Map<string, FrameAnalysis>>(() => new Map());
  const [playingPicks, setPlayingPicks] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [message, setMessage] = useState("Select source frames before extraction");
  const markerThumbnailKey = selection.markers.map((marker) => `${marker.id}:${marker.timeMs}`).join("|");
  const frameStepMs = 1000 / selection.sourceFps;
  const storedRangeStartMs = Math.min(Math.max(0, selection.rangeStartMs ?? 0), Math.max(0, durationMs - 1));
  const storedRangeEndMs = Math.min(durationMs, Math.max(storedRangeStartMs + 1, selection.rangeEndMs ?? durationMs));
  const rangeStartMs = dragRange?.startMs ?? storedRangeStartMs;
  const rangeEndMs = dragRange?.endMs ?? storedRangeEndMs;
  const rangeDurationMs = rangeEndMs - rangeStartMs;
  const autoFrameCount = automaticMarkerCount(rangeDurationMs, extractFps);
  const autoSelectionTooLarge = autoFrameCount > MAX_SOURCE_MARKERS;
  const maximumAutomaticFps = Math.max(1, Math.min(24, Math.floor(MAX_SOURCE_MARKERS / Math.max(0.001, rangeDurationMs / 1000))));

  useEffect(() => { thumbnailsRef.current = thumbnails; }, [thumbnails]);
  useEffect(() => { analysesRef.current = analyses; }, [analyses]);

  useEffect(() => {
    if (!hasPendingOutput) return;
    setPlayingPicks(false);
    setMessage("Extracted frames are ready. Choose an output method below.");
  }, [hasPendingOutput]);

  useEffect(() => {
    thumbnailsRef.current = new Map();
    analysesRef.current = new Map();
    setThumbnails(new Map());
    setAnalyses(new Map());
    setPlayingPicks(false);
    setPlaybackIndex(0);
    setDragRange(null);
    setPlayheadMs(selection.playheadMs);
    setSelectedId((current) => selection.markers.some((marker) => marker.id === current) ? current : selection.markers[0]?.id ?? null);
  }, [selection.sourceVideoId]);

  useEffect(() => {
    if (!playingPicks || selection.markers.length === 0) return;
    const timer = window.setInterval(() => setPlaybackIndex((index) => (index + 1) % selection.markers.length), 1000 / playbackFps);
    return () => window.clearInterval(timer);
  }, [playingPicks, selection.markers.length, playbackFps]);

  useEffect(() => {
    let active = true;
    const markerIds = new Set(selection.markers.map((marker) => marker.id));
    setThumbnails((current) => new Map([...current].filter(([id]) => markerIds.has(id))));
    const pending = selection.markers.filter((marker) => thumbnailsRef.current.get(marker.id)?.timeMs !== marker.timeMs);
    if (!pending.length) return;

    void (async () => {
      const decoder = document.createElement("video");
      decoder.muted = true;
      decoder.playsInline = true;
      decoder.preload = "auto";
      decoder.src = asset.url;
      await waitForMetadata(decoder);
      const source = document.createElement("canvas");
      source.width = decoder.videoWidth;
      source.height = decoder.videoHeight;
      const sourceContext = source.getContext("2d", { willReadFrequently: true });
      const preview = document.createElement("canvas");
      preview.width = 112;
      preview.height = 112;
      const previewContext = preview.getContext("2d");
      const playbackPreview = document.createElement("canvas");
      const playbackScale = Math.min(1, 512 / Math.max(source.width, source.height));
      playbackPreview.width = Math.max(1, Math.round(source.width * playbackScale));
      playbackPreview.height = Math.max(1, Math.round(source.height * playbackScale));
      const playbackContext = playbackPreview.getContext("2d");
      if (!sourceContext || !previewContext || !playbackContext) return;
      previewContext.imageSmoothingEnabled = true;
      previewContext.imageSmoothingQuality = "high";
      playbackContext.imageSmoothingEnabled = true;
      playbackContext.imageSmoothingQuality = "high";

      for (const marker of pending) {
        if (!active) break;
        try {
          await seekVideo(decoder, marker.timeMs);
          sourceContext.clearRect(0, 0, source.width, source.height);
          sourceContext.drawImage(decoder, 0, 0);
          previewContext.fillStyle = "#11161d";
          previewContext.fillRect(0, 0, preview.width, preview.height);
          const scale = Math.min(preview.width / source.width, preview.height / source.height);
          const width = Math.round(source.width * scale);
          const height = Math.round(source.height * scale);
          previewContext.drawImage(source, Math.round((preview.width - width) / 2), Math.round((preview.height - height) / 2), width, height);
          playbackContext.clearRect(0, 0, playbackPreview.width, playbackPreview.height);
          playbackContext.drawImage(source, 0, 0, playbackPreview.width, playbackPreview.height);
          const thumbnail = {
            dataUrl: preview.toDataURL("image/png"),
            playbackDataUrl: playbackPreview.toDataURL("image/png"),
            timeMs: marker.timeMs,
          };
          if (active) setThumbnails((current) => new Map(current).set(marker.id, thumbnail));
        } catch (error) {
          if (active) setThumbnails((current) => new Map(current).set(marker.id, { dataUrl: "", playbackDataUrl: "", timeMs: marker.timeMs, error: error instanceof Error ? error.message : "Frame preview failed" }));
        }
      }
      decoder.removeAttribute("src");
      decoder.load();
    })().catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "Frame previews failed"); });
    return () => { active = false; };
  }, [asset.url, markerThumbnailKey]);

  useEffect(() => {
    let active = true;
    const markerIds = new Set(selection.markers.map((marker) => marker.id));
    if (backgroundMode !== "transparent") {
      analysesRef.current = new Map();
      setAnalyses(new Map());
      return () => { active = false; };
    }

    setAnalyses((current) => new Map([...current].filter(([id]) => markerIds.has(id))));
    const pending = selection.markers.filter((marker) => {
      const cacheKey = `${asset.metadata.id}:${marker.timeMs}:${chromaKey}`;
      return analysesRef.current.get(marker.id)?.cacheKey !== cacheKey;
    });
    if (!pending.length) return () => { active = false; };

    void (async () => {
      const decoder = document.createElement("video");
      decoder.muted = true;
      decoder.playsInline = true;
      decoder.preload = "auto";
      decoder.src = asset.url;
      await waitForMetadata(decoder);
      const source = document.createElement("canvas");
      source.width = decoder.videoWidth;
      source.height = decoder.videoHeight;
      const sourceContext = source.getContext("2d", { willReadFrequently: true });
      if (!sourceContext) return;

      for (const marker of pending) {
        if (!active) break;
        const cacheKey = `${asset.metadata.id}:${marker.timeMs}:${chromaKey}`;
        try {
          await seekVideo(decoder, marker.timeMs);
          sourceContext.clearRect(0, 0, source.width, source.height);
          sourceContext.drawImage(decoder, 0, 0);
          const result = removeChromaBackground(sourceContext.getImageData(0, 0, source.width, source.height), chromaKey);
          const warning = result.stats.success ? undefined : result.stats.reason ?? "The selected chroma background may not be removable";
          if (active) setAnalyses((current) => new Map(current).set(marker.id, { cacheKey, warning }));
        } catch (error) {
          const warning = error instanceof Error ? error.message : "Background-removal preflight failed";
          if (active) setAnalyses((current) => new Map(current).set(marker.id, { cacheKey, warning }));
        }
      }
      decoder.removeAttribute("src");
      decoder.load();
    })().catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "Background-removal preflight failed"); });
    return () => { active = false; };
  }, [asset.metadata.id, asset.url, backgroundMode, chromaKey, markerThumbnailKey]);

  const effectiveMarkers = useMemo(() => selection.markers.map((marker) => marker.id === dragIdRef.current && dragTimeMs !== null ? { ...marker, timeMs: dragTimeMs } : marker), [selection.markers, dragTimeMs]);
  const activePlaybackMarker = playingPicks ? selection.markers[playbackIndex % Math.max(1, selection.markers.length)] : undefined;
  const activePlaybackThumbnail = activePlaybackMarker ? thumbnails.get(activePlaybackMarker.id)?.playbackDataUrl : undefined;
  const currentFrameIndex = frameIndexAtTime(playheadMs, selection.sourceFps, durationMs);
  const playheadInRange = playheadMs >= rangeStartMs && playheadMs < rangeEndMs;

  const changeSelection = (patch: Partial<SourceFrameSelection>) => onChange({ ...selection, ...patch });
  const persistPlayhead = (timeMs = playheadMs) => changeSelection({ playheadMs: timeMs });
  const seekTo = (timeMs: number, persist = false) => {
    const next = Math.min(Math.max(0, timeMs), Math.max(0, durationMs - 1));
    setPlayheadMs(next);
    if (videoRef.current) void seekVideo(videoRef.current, next);
    if (persist) persistPlayhead(next);
  };
  const stepFrame = (delta: number) => seekTo(timeForSourceFrame(currentFrameIndex + delta, selection.sourceFps, durationMs), true);
  const changeRange = (nextStartMs: number, nextEndMs: number) => {
    const start = Math.min(Math.max(0, nextStartMs), Math.max(0, nextEndMs - frameStepMs));
    const end = Math.min(durationMs, Math.max(start + frameStepMs, nextEndMs));
    let markers: SourceFrameMarker[];
    try {
      markers = createAutomaticMarkers(durationMs, extractFps, selection.sourceFps, start, end);
      setMessage(`${markers.length} frames selected from ${formatTime(start)}–${formatTime(end)}`);
    } catch (error) {
      markers = selection.markers.filter((marker) => marker.timeMs >= start && marker.timeMs < end);
      setMessage(error instanceof Error ? error.message : "Automatic frame selection failed for this range");
    }
    const nextPlayhead = start;
    setPlayheadMs(nextPlayhead);
    if (videoRef.current) void seekVideo(videoRef.current, nextPlayhead);
    onChange({ ...selection, rangeStartMs: start, rangeEndMs: end, playheadMs: nextPlayhead, markers });
    setSelectedId(markers[0]?.id ?? null);
  };
  const toggleCurrentMarker = () => {
    if (!playheadInRange) { setMessage("Move the playhead inside the extraction range before marking a frame"); return; }
    const existing = selection.markers.find((marker) => frameIndexAtTime(marker.timeMs, selection.sourceFps, durationMs) === currentFrameIndex);
    const markers = existing
      ? selection.markers.filter((marker) => marker.id !== existing.id)
      : addSourceMarker(selection.markers, playheadMs, selection.sourceFps, durationMs, crypto.randomUUID(), rangeStartMs, rangeEndMs);
    if (markers === selection.markers) setMessage(selection.markers.length >= MAX_SOURCE_MARKERS ? "The 240 frame selection limit has been reached" : "This source frame is already marked");
    else {
      changeSelection({ markers, playheadMs });
      setSelectedId(existing ? null : markers.find((marker) => frameIndexAtTime(marker.timeMs, selection.sourceFps, durationMs) === currentFrameIndex)?.id ?? null);
      setMessage(existing ? "Marker removed" : `Frame ${currentFrameIndex + 1} marked`);
    }
  };
  const removeMarker = (id: string) => {
    changeSelection({ markers: selection.markers.filter((marker) => marker.id !== id) });
    if (selectedId === id) setSelectedId(null);
  };
  const playPicks = () => {
    if (!selection.markers.length) return;
    videoRef.current?.pause();
    setPlaybackIndex(0);
    setPlayingPicks((value) => !value);
  };

  const markerTimeFromPointer = (clientX: number) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.min(durationMs - 1, Math.max(0, (clientX - rect.left) / rect.width * durationMs));
  };
  const rangeTimeFromPointer = (clientX: number, boundary: "start" | "end") => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return boundary === "start" ? rangeStartMs : rangeEndMs;
    const raw = Math.min(durationMs, Math.max(0, (clientX - rect.left) / rect.width * durationMs));
    if (boundary === "end" && raw >= durationMs - frameStepMs / 2) return durationMs;
    return timeForSourceFrame(frameIndexAtTime(raw, selection.sourceFps, durationMs), selection.sourceFps, durationMs);
  };
  const previewRangeBoundary = (boundary: "start" | "end", clientX: number) => {
    const timeMs = rangeTimeFromPointer(clientX, boundary);
    const current = rangeValueRef.current ?? { startMs: storedRangeStartMs, endMs: storedRangeEndMs };
    const next = boundary === "start"
      ? { startMs: Math.min(Math.max(0, timeMs), Math.max(0, current.endMs - frameStepMs)), endMs: current.endMs }
      : { startMs: current.startMs, endMs: Math.min(durationMs, Math.max(current.startMs + frameStepMs, timeMs)) };
    rangeValueRef.current = next;
    setDragRange(next);
    seekTo(boundary === "start" ? next.startMs : Math.max(next.startMs, next.endMs - 1));
  };
  const onRangePointerDown = (event: React.PointerEvent<HTMLButtonElement>, boundary: "start" | "end") => {
    event.preventDefault(); event.stopPropagation();
    rangeDragRef.current = boundary;
    rangeValueRef.current = { startMs: storedRangeStartMs, endMs: storedRangeEndMs };
    event.currentTarget.setPointerCapture(event.pointerId);
    previewRangeBoundary(boundary, event.clientX);
  };
  const onRangePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const boundary = rangeDragRef.current;
    if (!boundary || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    previewRangeBoundary(boundary, event.clientX);
  };
  const onRangePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!rangeDragRef.current) return;
    event.preventDefault(); event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const next = rangeValueRef.current ?? { startMs: storedRangeStartMs, endMs: storedRangeEndMs };
    rangeDragRef.current = null;
    rangeValueRef.current = null;
    setDragRange(null);
    changeRange(next.startMs, next.endMs);
  };
  const onRangeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, boundary: "start" | "end") => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault(); event.stopPropagation();
    const delta = event.key === "ArrowLeft" ? -frameStepMs : frameStepMs;
    if (boundary === "start") changeRange(Math.min(storedRangeEndMs - frameStepMs, storedRangeStartMs + delta), storedRangeEndMs);
    else changeRange(storedRangeStartMs, Math.max(storedRangeStartMs + frameStepMs, storedRangeEndMs + delta));
  };
  const onMarkerPointerDown = (event: React.PointerEvent<HTMLButtonElement>, marker: SourceFrameMarker) => {
    event.preventDefault(); event.stopPropagation();
    dragIdRef.current = marker.id;
    dragTimeRef.current = marker.timeMs;
    dragMovedRef.current = false;
    setSelectedId(marker.id);
    setDragTimeMs(marker.timeMs);
    event.currentTarget.setPointerCapture(event.pointerId);
    seekTo(marker.timeMs);
  };
  const onMarkerPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const id = dragIdRef.current;
    if (!id || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const moved = moveSourceMarker(selection.markers, id, markerTimeFromPointer(event.clientX), selection.sourceFps, durationMs, rangeStartMs, rangeEndMs);
    const marker = moved.find((candidate) => candidate.id === id);
    if (marker) { dragTimeRef.current = marker.timeMs; dragMovedRef.current = marker.timeMs !== selection.markers.find((candidate) => candidate.id === id)?.timeMs; setDragTimeMs(marker.timeMs); seekTo(marker.timeMs); }
  };
  const onMarkerPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const id = dragIdRef.current;
    if (!id) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const markers = moveSourceMarker(selection.markers, id, dragTimeRef.current ?? 0, selection.sourceFps, durationMs, rangeStartMs, rangeEndMs);
    const marker = markers.find((candidate) => candidate.id === id);
    dragIdRef.current = null; dragTimeRef.current = null; setDragTimeMs(null);
    changeSelection({ markers, playheadMs: marker?.timeMs ?? playheadMs });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.matches("input") && (target as HTMLInputElement).type !== "range") return;
    if (event.key === "ArrowLeft") { event.preventDefault(); stepFrame(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); stepFrame(1); }
    else if (event.key.toLowerCase() === "m") { event.preventDefault(); toggleCurrentMarker(); }
    else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) { event.preventDefault(); removeMarker(selectedId); }
    else if (event.code === "Space") { event.preventDefault(); playPicks(); }
  };

  return <div className="source-picker" tabIndex={0} onKeyDown={onKeyDown} aria-label="Source video frame picker">
    <div className="source-video-frame">
      <video ref={videoRef} src={asset.url} controls playsInline muted loop preload="metadata" aria-label="Generated or imported source video" onTimeUpdate={(event) => { if (!playingPicks) setPlayheadMs(event.currentTarget.currentTime * 1000); }} />
      {playingPicks && <div className="picked-playback" aria-label="Selected frame playback">{activePlaybackThumbnail ? <img src={activePlaybackThumbnail} alt={`Selected frame ${playbackIndex + 1}`} /> : <span>Preparing selected frame…</span>}</div>}
    </div>

    <div className="source-video-details"><span>{asset.metadata.origin === "generated" ? "Generated" : "Imported"}</span><span>{asset.metadata.duration ? `${asset.metadata.duration.toFixed(1)}s` : "Duration unavailable"}</span><span>{asset.metadata.width || "—"} × {asset.metadata.height || "—"}</span></div>

    <div className="picker-transport">
      <button onClick={() => stepFrame(-1)} aria-label="Previous source frame" title="Previous frame"><ArrowLeft /></button>
      <button onClick={() => stepFrame(1)} aria-label="Next source frame" title="Next frame"><ArrowRight /></button>
      <div className="picker-position"><strong>Frame {currentFrameIndex + 1} / {totalFrames}</strong><span>{formatTime(playheadMs)}</span></div>
      <label>Source FPS<input type="number" min="1" max="120" step="0.001" value={selection.sourceFps} onChange={(event) => changeSelection({ sourceFps: normalizeSourceFps(Number(event.target.value)) })} /></label>
      <button className="mark-frame" onClick={toggleCurrentMarker} disabled={!playheadInRange} title={playheadInRange ? "Add or remove the current frame" : "Move inside the extraction range to mark a frame"}><Plus /> Mark current frame</button>
    </div>

    <input className="frame-scrubber" aria-label="Source frame" type="range" min="0" max={Math.max(0, totalFrames - 1)} value={currentFrameIndex} onChange={(event) => seekTo(timeForSourceFrame(Number(event.target.value), selection.sourceFps, durationMs))} onPointerUp={() => persistPlayhead()} onKeyUp={() => persistPlayhead()} onBlur={() => persistPlayhead()} />

    <div className="marker-timeline-heading"><strong>Extract range</strong><span>{formatTime(rangeStartMs)}–{formatTime(rangeEndMs)} · {(rangeDurationMs / 1000).toFixed(3)}s selected</span></div>
    <div className="marker-timeline" ref={timelineRef} onClick={(event) => seekTo(markerTimeFromPointer(event.clientX), true)}>
      <div className="source-range-window" style={{ left: `${rangeStartMs / durationMs * 100}%`, width: `${rangeDurationMs / durationMs * 100}%` }} />
      <button className="source-range-handle range-start" style={{ left: `${rangeStartMs / durationMs * 100}%` }} aria-label={`Extraction range starts at ${formatTime(rangeStartMs)}`} title={`Start ${formatTime(rangeStartMs)}`} onPointerDown={(event) => onRangePointerDown(event, "start")} onPointerMove={onRangePointerMove} onPointerUp={onRangePointerUp} onKeyDown={(event) => onRangeKeyDown(event, "start")} onClick={(event) => event.stopPropagation()} />
      <button className="source-range-handle range-end" style={{ left: `${rangeEndMs / durationMs * 100}%` }} aria-label={`Extraction range ends at ${formatTime(rangeEndMs)}`} title={`End ${formatTime(rangeEndMs)}`} onPointerDown={(event) => onRangePointerDown(event, "end")} onPointerMove={onRangePointerMove} onPointerUp={onRangePointerUp} onKeyDown={(event) => onRangeKeyDown(event, "end")} onClick={(event) => event.stopPropagation()} />
      {effectiveMarkers.map((marker) => <button
        key={marker.id}
        className={`source-marker ${selectedId === marker.id ? "selected" : ""} ${failedMarkerIds.includes(marker.id) ? "failed" : ""}`}
        style={{ left: `${marker.timeMs / durationMs * 100}%` }}
        aria-label={`Selected source frame ${frameIndexAtTime(marker.timeMs, selection.sourceFps, durationMs) + 1}`}
        title={`Frame ${frameIndexAtTime(marker.timeMs, selection.sourceFps, durationMs) + 1} · ${formatTime(marker.timeMs)}`}
        onPointerDown={(event) => onMarkerPointerDown(event, marker)}
        onPointerMove={onMarkerPointerMove}
        onPointerUp={onMarkerPointerUp}
        onClick={(event) => { event.stopPropagation(); if (dragMovedRef.current) { dragMovedRef.current = false; return; } setSelectedId(marker.id); seekTo(marker.timeMs, true); }}
      />)}
    </div>

    <div className="picker-actions">
      <label className="extract-fps-field">Extract FPS<input type="number" min="1" max="24" step="1" value={extractFps} onChange={(event) => onExtractFpsChange(normalizeExtractFps(Number(event.target.value)))} /></label>
      <button disabled={autoSelectionTooLarge} onClick={() => {
        if (!selection.markers.length || window.confirm("Replace the current selection with evenly sampled frames?")) {
          try { changeSelection({ markers: createAutomaticMarkers(durationMs, extractFps, selection.sourceFps, rangeStartMs, rangeEndMs), playheadMs: rangeStartMs }); seekTo(rangeStartMs); }
          catch (error) { setMessage(error instanceof Error ? error.message : "Automatic frame selection failed"); }
        }
      }}><FilmStrip /> Auto-select at {extractFps} FPS</button>
      <button onClick={playPicks} disabled={!selection.markers.length}>{playingPicks ? <Pause /> : <Play />}{playingPicks ? "Pause selection" : "Play selection"}</button>
      <button onClick={() => { if (selection.markers.length && window.confirm("Clear all selected source frames?")) changeSelection({ markers: [] }); }} disabled={!selection.markers.length}><X /> Clear</button>
      {!hasPendingOutput && <button className="extract-selected" onClick={busy ? onCancel : onExtract} disabled={!busy && !selection.markers.length}>{busy ? <><X /> Cancel extraction</> : <><FilmStrip /> Extract {selection.markers.length} selected frames</>}</button>}
      <span>{selection.markers.length} / {MAX_SOURCE_MARKERS} selected</span>
    </div>
    {autoSelectionTooLarge && <div className="picker-limit-warning" role="status">{extractFps} FPS would create {autoFrameCount} frames. Use {maximumAutomaticFps} FPS or lower for this video.</div>}

    <div className="picked-strip" aria-label="Selected source frames">
      {!selection.markers.length && <div className="picked-empty">Scrub the source video and mark the frames you want to extract.</div>}
      {selection.markers.map((marker, index) => {
        const thumbnail = thumbnails.get(marker.id);
        const preflightWarning = analyses.get(marker.id)?.warning;
        const warning = thumbnail?.error ?? preflightWarning;
        const warningTitle = thumbnail?.error
          ? thumbnail.error
          : preflightWarning
            ? `Background-removal preflight warning: ${preflightWarning}`
            : undefined;
        return <div key={marker.id} className={`picked-thumb ${selectedId === marker.id ? "selected" : ""} ${warning || failedMarkerIds.includes(marker.id) ? "warning" : ""}`} title={warningTitle}>
          <button className="picked-thumb-main" draggable={Boolean(thumbnail?.dataUrl)} onDragStart={(event) => onReferenceDragStart(event, marker.id)} title="Go to frame, or drag the original frame to Reference" onClick={() => { setSelectedId(marker.id); seekTo(marker.timeMs, true); }} aria-label={`Go to selected frame ${index + 1}`}>
            {thumbnail?.dataUrl ? <img draggable={false} src={thumbnail.dataUrl} alt="" /> : <span className="thumb-loading">…</span>}
            <span>{index + 1} · f{frameIndexAtTime(marker.timeMs, selection.sourceFps, durationMs) + 1}</span>
          </button>
          <button className="remove-pick" aria-label={`Remove selected frame ${index + 1}`} onClick={() => removeMarker(marker.id)}><X /></button>
        </div>;
      })}
    </div>

    <div className="picker-status" role="status">{message}</div>
  </div>;
}
