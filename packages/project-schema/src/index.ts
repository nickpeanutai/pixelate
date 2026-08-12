export interface ProjectFrame {
  id: string;
  name: string;
  dataUrl: string;
  durationMs: number;
  offsetX: number;
  offsetY: number;
  mirrored: boolean;
  warnings: string[];
  width: number;
  height: number;
  processing: "original" | "pixel-art";
}

export type ChromaKeyName = "magenta" | "green";
export type BackgroundMode = "transparent" | "opaque";

export interface SourceVideoMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  createdAt: string;
  origin: "generated" | "imported";
}

export interface SourceFrameMarker {
  id: string;
  timeMs: number;
}

export interface SourceFrameSelection {
  sourceVideoId: string;
  sourceFps: number;
  extractFps: number;
  rangeStartMs: number;
  rangeEndMs: number;
  playheadMs: number;
  markers: SourceFrameMarker[];
}

export interface ReferenceImageMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  createdAt: string;
  origin: "upload" | "canvas" | "gallery";
}

export interface SourceImageMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  createdAt: string;
  origin: "external";
}

export const DEFAULT_IMAGE_TEMPLATE_ID = "animation-ready-character-v1";
export const DEFAULT_VIDEO_TEMPLATE_ID = "seamless-in-place-v1";
export const PROMPT_IMAGE_SIZES = [32, 64, 128, 256] as const;
export type PromptImageSize = typeof PROMPT_IMAGE_SIZES[number];
export const DEFAULT_PROMPT_IMAGE_SIZE: PromptImageSize = 256;

export interface PromptDraft {
  templateId: string;
  userText: string;
  imageSize?: PromptImageSize;
  generatedPrompt?: string;
  generatedAt?: string;
}

export interface PromptWorkflow {
  image: PromptDraft;
  video: PromptDraft;
}

export interface PixelProject {
  schemaVersion: 13;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: "image" | "animation";
  target: {
    width: number;
    height: number;
    paletteSize: number;
    fps: number;
    loop: boolean;
    backgroundMode: BackgroundMode;
    chromaKey: ChromaKeyName;
    pixelSizeMode: "detected" | "manual";
  };
  frames: ProjectFrame[];
  sourceVideo?: SourceVideoMetadata;
  sourceSelection?: SourceFrameSelection;
  referenceImage?: ReferenceImageMetadata;
  sourceImage?: SourceImageMetadata;
  promptWorkflow: PromptWorkflow;
}

const defaultPromptWorkflow = (): PromptWorkflow => ({
  image: { templateId: DEFAULT_IMAGE_TEMPLATE_ID, userText: "", imageSize: DEFAULT_PROMPT_IMAGE_SIZE },
  video: { templateId: DEFAULT_VIDEO_TEMPLATE_ID, userText: "" },
});

export function createProject(name = "Untitled sprite"): PixelProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: 13,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    mode: "image",
    target: {
      width: 64,
      height: 64,
      paletteSize: 24,
      fps: 1,
      loop: true,
      backgroundMode: "transparent",
      chromaKey: "magenta",
      pixelSizeMode: "detected",
    },
    frames: [],
    promptWorkflow: defaultPromptWorkflow(),
  };
}

export function migrateProject(value: unknown): PixelProject {
  const input = value && typeof value === "object" ? value as Partial<PixelProject> & Record<string, any> : {};
  const {
    provider: _legacyProvider,
    generation: _legacyGeneration,
    workflow: legacyWorkflow,
    prompt: legacyPrompt,
    promptWorkflow: rawPromptWorkflow,
    ...safeInput
  } = input;
  const fallback = createProject(typeof input.name === "string" ? input.name : "Untitled sprite");
  const previousSchemaVersion = typeof input.schemaVersion === "number" ? input.schemaVersion : 0;
  const target: Partial<PixelProject["target"]> = input.target && typeof input.target === "object" ? input.target : {};
  const previousFps = typeof target.fps === "number" && Number.isFinite(target.fps)
    ? Math.min(60, Math.max(1, Math.round(target.fps)))
    : fallback.target.fps;
  const sourceVideo = input.sourceVideo && typeof input.sourceVideo === "object" && typeof input.sourceVideo.id === "string"
    ? input.sourceVideo as SourceVideoMetadata
    : undefined;
  const rawSelection = input.sourceSelection && typeof input.sourceSelection === "object" ? input.sourceSelection as Partial<SourceFrameSelection> : undefined;
  const sourceSelection = sourceVideo && rawSelection?.sourceVideoId === sourceVideo.id
    ? (() => {
      const durationMs = Math.max(1, sourceVideo.duration * 1000);
      const rangeStartMs = typeof rawSelection.rangeStartMs === "number" && Number.isFinite(rawSelection.rangeStartMs)
        ? Math.min(Math.max(0, rawSelection.rangeStartMs), durationMs - 1)
        : 0;
      const rangeEndMs = typeof rawSelection.rangeEndMs === "number" && Number.isFinite(rawSelection.rangeEndMs)
        ? Math.min(durationMs, Math.max(rangeStartMs + 1, rawSelection.rangeEndMs))
        : durationMs;
      return {
        sourceVideoId: sourceVideo.id,
        sourceFps: typeof rawSelection.sourceFps === "number" && Number.isFinite(rawSelection.sourceFps)
          ? Math.min(120, Math.max(1, rawSelection.sourceFps))
          : 24,
        extractFps: typeof rawSelection.extractFps === "number" && Number.isFinite(rawSelection.extractFps)
          ? previousSchemaVersion <= 11 && Math.round(rawSelection.extractFps) === 12
            ? 1
            : Math.min(24, Math.max(1, Math.round(rawSelection.extractFps)))
          : 1,
        rangeStartMs,
        rangeEndMs,
        playheadMs: typeof rawSelection.playheadMs === "number" && Number.isFinite(rawSelection.playheadMs)
          ? Math.min(Math.max(0, rawSelection.playheadMs), Math.max(0, sourceVideo.duration * 1000 - 1))
          : 0,
        markers: Array.isArray(rawSelection.markers)
          ? rawSelection.markers
              .filter((marker): marker is SourceFrameMarker => Boolean(marker && typeof marker.id === "string" && typeof marker.timeMs === "number" && Number.isFinite(marker.timeMs)))
              .map((marker) => ({ ...marker, timeMs: Math.min(Math.max(0, marker.timeMs), Math.max(0, sourceVideo.duration * 1000 - 1)) }))
              .filter((marker) => marker.timeMs >= rangeStartMs && marker.timeMs < rangeEndMs)
              .sort((a, b) => a.timeMs - b.timeMs)
              .filter((marker, index, markers) => index === 0 || marker.timeMs !== markers[index - 1].timeMs)
              .slice(0, 240)
          : [],
      } satisfies SourceFrameSelection;
    })()
    : undefined;
  const referenceImage = input.referenceImage && typeof input.referenceImage === "object" && typeof input.referenceImage.id === "string"
    ? input.referenceImage as ReferenceImageMetadata
    : undefined;
  const sourceImage = input.sourceImage && typeof input.sourceImage === "object" && typeof input.sourceImage.id === "string"
    ? input.sourceImage as SourceImageMetadata
    : undefined;
  const rawWorkflow = rawPromptWorkflow && typeof rawPromptWorkflow === "object"
    ? rawPromptWorkflow as Partial<PromptWorkflow>
    : {};
  const readDraft = (kind: "image" | "video"): PromptDraft => {
    const value = rawWorkflow[kind] && typeof rawWorkflow[kind] === "object"
      ? rawWorkflow[kind] as Partial<PromptDraft>
      : {};
    const expectedTemplate = kind === "image" ? DEFAULT_IMAGE_TEMPLATE_ID : DEFAULT_VIDEO_TEMPLATE_ID;
    const templateId = value.templateId === expectedTemplate ? value.templateId : expectedTemplate;
    const migratedLegacyText = typeof legacyPrompt === "string" && input.mode === (kind === "video" ? "animation" : "image")
      ? legacyPrompt
      : "";
    return {
      templateId,
      userText: typeof value.userText === "string" ? value.userText : migratedLegacyText,
      ...(kind === "image" ? {
        imageSize: PROMPT_IMAGE_SIZES.includes(value.imageSize as PromptImageSize)
          ? value.imageSize as PromptImageSize
          : DEFAULT_PROMPT_IMAGE_SIZE,
      } : {}),
      ...(typeof value.generatedPrompt === "string" ? { generatedPrompt: value.generatedPrompt } : {}),
      ...(typeof value.generatedAt === "string" ? { generatedAt: value.generatedAt } : {}),
    };
  };
  const promptWorkflow: PromptWorkflow = { image: readDraft("image"), video: readDraft("video") };
  return {
    ...fallback,
    ...safeInput,
    schemaVersion: 13,
    id: typeof input.id === "string" ? input.id : fallback.id,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : fallback.createdAt,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : fallback.updatedAt,
    mode: input.mode === "animation" ? "animation" : "image",
    target: {
      ...fallback.target,
      ...target,
      fps: sourceVideo && previousSchemaVersion <= 10 ? fallback.target.fps : previousFps,
      pixelSizeMode: target.pixelSizeMode === "manual" ? "manual" : "detected",
    },
    frames: Array.isArray(input.frames)
      ? input.frames
          .filter((frame): frame is ProjectFrame => Boolean(frame && typeof frame.dataUrl === "string"))
          .map((frame) => ({
            ...frame,
            width: typeof frame.width === "number" && frame.width > 0 ? frame.width : (typeof target.width === "number" ? target.width : fallback.target.width),
            height: typeof frame.height === "number" && frame.height > 0 ? frame.height : (typeof target.height === "number" ? target.height : fallback.target.height),
            processing: frame.processing === "original" ? "original" as const : "pixel-art" as const,
            durationMs: sourceVideo && previousSchemaVersion <= 10 ? Math.round(1000 / fallback.target.fps) : frame.durationMs,
          }))
      : [],
    sourceVideo,
    sourceSelection,
    referenceImage,
    sourceImage,
    promptWorkflow,
  };
}

const secretPattern = /(key|secret|token|authorization|credential)/i;
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSecrets) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !secretPattern.test(key)).map(([key, child]) => [key, stripSecrets(child)])) as T;
  }
  return value;
}

async function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pixel-sprite-studio", 6);
    request.onupgradeneeded = (event) => {
      if (!request.result.objectStoreNames.contains("projects")) request.result.createObjectStore("projects", { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings", { keyPath: "key" });
      if (request.result.objectStoreNames.contains("credentials")) request.result.deleteObjectStore("credentials");
      if (request.result.objectStoreNames.contains("providerConnections")) request.result.deleteObjectStore("providerConnections");
      if (request.result.objectStoreNames.contains("providerCredentials")) request.result.deleteObjectStore("providerCredentials");
      if (request.result.objectStoreNames.contains("recentModels")) request.result.deleteObjectStore("recentModels");
      const settings = request.transaction?.objectStore("settings");
      settings?.delete("connection:image");
      settings?.delete("connection:video");
      settings?.delete("connectionMigrationNotice");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProjectMetadata(project: PixelProject) {
  const db = await openDatabase();
  const safe = stripSecrets({ ...project, updatedAt: new Date().toISOString(), frames: project.frames.map(({ dataUrl: _dataUrl, ...frame }) => frame) });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(["projects", "settings"], "readwrite");
    transaction.objectStore("projects").put(safe);
    transaction.objectStore("settings").put({ key: "lastProjectId", value: project.id });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function loadLastProject(): Promise<PixelProject | undefined> {
  const db = await openDatabase();
  try {
    const lastProjectId = await new Promise<string | undefined>((resolve, reject) => {
      const request = db.transaction("settings").objectStore("settings").get("lastProjectId");
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
    if (!lastProjectId) return undefined;
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction("projects").objectStore("projects").get(lastProjectId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return stored ? migrateProject(stored) : undefined;
  } finally {
    db.close();
  }
}

async function videoDirectory(projectId: string, create: boolean) {
  const root = await navigator.storage.getDirectory();
  const projects = await root.getDirectoryHandle("projects", { create });
  const project = await projects.getDirectoryHandle(projectId, { create });
  return project.getDirectoryHandle("videos", { create });
}

async function referenceDirectory(projectId: string, create: boolean) {
  const root = await navigator.storage.getDirectory();
  const projects = await root.getDirectoryHandle("projects", { create });
  const project = await projects.getDirectoryHandle(projectId, { create });
  return project.getDirectoryHandle("references", { create });
}

async function imageDirectory(projectId: string, create: boolean) {
  const root = await navigator.storage.getDirectory();
  const projects = await root.getDirectoryHandle("projects", { create });
  const project = await projects.getDirectoryHandle(projectId, { create });
  return project.getDirectoryHandle("images", { create });
}

export async function saveSourceVideo(projectId: string, metadata: SourceVideoMetadata, blob: Blob) {
  const directory = await videoDirectory(projectId, true);
  const handle = await directory.getFileHandle(metadata.id, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

export async function loadSourceVideo(projectId: string, videoId: string): Promise<Blob | undefined> {
  try {
    const directory = await videoDirectory(projectId, false);
    const handle = await directory.getFileHandle(videoId);
    return await handle.getFile();
  } catch (error) {
    if ((error as DOMException).name === "NotFoundError") return undefined;
    throw error;
  }
}

export async function deleteSourceVideo(projectId: string, videoId: string) {
  try {
    const directory = await videoDirectory(projectId, false);
    await directory.removeEntry(videoId);
  } catch (error) {
    if ((error as DOMException).name !== "NotFoundError") throw error;
  }
}


export async function saveReferenceImage(projectId: string, metadata: ReferenceImageMetadata, blob: Blob) {
  const directory = await referenceDirectory(projectId, true);
  const handle = await directory.getFileHandle(metadata.id, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

export async function loadReferenceImage(projectId: string, referenceId: string): Promise<Blob | undefined> {
  try {
    const directory = await referenceDirectory(projectId, false);
    const handle = await directory.getFileHandle(referenceId);
    return await handle.getFile();
  } catch (error) {
    if ((error as DOMException).name === "NotFoundError") return undefined;
    throw error;
  }
}

export async function deleteReferenceImage(projectId: string, referenceId: string) {
  try {
    const directory = await referenceDirectory(projectId, false);
    await directory.removeEntry(referenceId);
  } catch (error) {
    if ((error as DOMException).name !== "NotFoundError") throw error;
  }
}

export async function saveSourceImage(projectId: string, metadata: SourceImageMetadata, blob: Blob) {
  const directory = await imageDirectory(projectId, true);
  const handle = await directory.getFileHandle(metadata.id, { create: true });
  const writable = await handle.createWritable();
  try { await writable.write(blob); }
  finally { await writable.close(); }
}

export async function loadSourceImage(projectId: string, imageId: string): Promise<Blob | undefined> {
  try {
    const directory = await imageDirectory(projectId, false);
    const handle = await directory.getFileHandle(imageId);
    return await handle.getFile();
  } catch (error) {
    if ((error as DOMException).name === "NotFoundError") return undefined;
    throw error;
  }
}

export async function deleteSourceImage(projectId: string, imageId: string) {
  try {
    const directory = await imageDirectory(projectId, false);
    await directory.removeEntry(imageId);
  } catch (error) {
    if ((error as DOMException).name !== "NotFoundError") throw error;
  }
}
