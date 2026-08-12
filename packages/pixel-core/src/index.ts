import {
  applyPerceptualPalette,
  derivePerceptualPalette,
  pixelateImageData,
  type PixelGridDetection,
} from "./pixel-art";

export {
  applyPerceptualPalette,
  derivePerceptualPalette,
  detectPseudoPixelGrid,
  edgeAwareDownscale,
  naiveResizeImageData,
  pixelateAnimationFrames,
  pixelateImageData,
  type PixelArtProcessOptions,
  type PixelArtProcessResult,
  type PixelGridDetection,
  type RGB,
} from "./pixel-art";

export type ChromaKeyName = "magenta" | "green";

export const CHROMA_KEY_RGB: Record<ChromaKeyName, [number, number, number]> = {
  magenta: [255, 0, 255],
  green: [0, 255, 0],
};

export interface ChromaOptions {
  key: [number, number, number];
  tolerance: number;
  feather: number;
  despill: number;
}

export interface ChromaMatteStats {
  expectedKey: [number, number, number];
  detectedKey: [number, number, number];
  keyDistance: number;
  opaqueRatio: number;
  keyResidueRatio: number;
  edgeContactRatio: number;
  success: boolean;
  reason?: string;
}

export interface ChromaMatteResult {
  imageData: ImageData;
  stats: ChromaMatteStats;
}

export interface ChromaReferenceResult {
  imageData: ImageData;
  transparentRatio: number;
  edgeTransparentRatio: number;
  success: boolean;
  reason?: string;
}

export interface VideoReferenceAssessment {
  pixelProcessingReady: boolean;
  videoReady: boolean;
  normalizationReady: boolean;
  requiresNormalization: boolean;
  detectedKey: [number, number, number];
  opaqueRatio: number;
  edgeContactRatio: number;
  minimumMarginRatio: number;
  fullyOpaque: boolean;
  warnings: string[];
  failures: string[];
}

export interface PreparedVideoReferenceResult {
  imageData: ImageData;
  assessment: VideoReferenceAssessment;
  success: boolean;
  reason?: string;
}

export interface PixelProcessOptions {
  chromaKey?: ChromaKeyName;
  /** Grid selected from the untouched source by the PerfectPixel detector. */
  gridHint?: PixelGridDetection;
}

export interface PixelProcessResult {
  canvas: HTMLCanvasElement;
  chroma?: ChromaMatteStats;
  analysis?: {
    grid: PixelGridDetection;
    gridRecovered: boolean;
  };
}

interface YCbCr { y: number; cb: number; cr: number }

const CHROMA_IN = 24;
const CHROMA_OUT = 72;
const DESPILL_BAND = 100;
const DESPILL_SCALE = 0.92;
const FLOOD_TOLERANCE = 88;

export function compositeReferenceOnChroma(source: ImageData, keyName: ChromaKeyName): ChromaReferenceResult {
  const key = CHROMA_KEY_RGB[keyName];
  const output = new ImageData(new Uint8ClampedArray(source.data.length), source.width, source.height);
  const pixelCount = source.width * source.height;
  let transparent = 0;
  let edgeTransparent = 0;
  let edgeTotal = 0;

  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const offset = (y * source.width + x) * 4;
    const alpha = source.data[offset + 3];
    if (alpha < 255) transparent++;
    const edge = x === 0 || y === 0 || x === source.width - 1 || y === source.height - 1;
    if (edge) {
      edgeTotal++;
      if (alpha <= 16) edgeTransparent++;
    }
    const weight = alpha / 255;
    output.data[offset] = Math.round(source.data[offset] * weight + key[0] * (1 - weight));
    output.data[offset + 1] = Math.round(source.data[offset + 1] * weight + key[1] * (1 - weight));
    output.data[offset + 2] = Math.round(source.data[offset + 2] * weight + key[2] * (1 - weight));
    output.data[offset + 3] = 255;
  }

  const transparentRatio = transparent / Math.max(1, pixelCount);
  const edgeTransparentRatio = edgeTransparent / Math.max(1, edgeTotal);
  const checks: Array<[boolean, string]> = [
    [transparentRatio >= 0.02, "The animation reference has no usable transparent background"],
    [edgeTransparentRatio >= 0.98, "The animation reference subject touches the image edge"],
  ];
  const failed = checks.find(([passes]) => !passes);
  return {
    imageData: output,
    transparentRatio,
    edgeTransparentRatio,
    success: !failed,
    reason: failed?.[1],
  };
}

function toYCbCr(r: number, g: number, b: number): YCbCr {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return { y, cb: (b - y) * 0.564 + 128, cr: (r - y) * 0.713 + 128 };
}

function fromYCbCr(color: YCbCr): [number, number, number] {
  return [
    clampByte(color.y + 1.402 * (color.cr - 128)),
    clampByte(color.y - 0.344136 * (color.cb - 128) - 0.714136 * (color.cr - 128)),
    clampByte(color.y + 1.772 * (color.cb - 128)),
  ];
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const chromaDistance = (a: YCbCr, b: YCbCr) => Math.hypot(a.cb - b.cb, a.cr - b.cr);

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(1, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function detectBackground(source: ImageData, expected: [number, number, number]) {
  const { width, height, data } = source;
  if (!width || !height) return expected;
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  const expectedYcc = toYCbCr(...expected);
  let expectedCount = 0;
  let expectedR = 0;
  let expectedG = 0;
  let expectedB = 0;
  let total = 0;

  const visit = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    const r = data[offset]; const g = data[offset + 1]; const b = data[offset + 2];
    const color = toYCbCr(r, g, b);
    const key = (Math.floor(color.cb / 8) << 6) | Math.floor(color.cr / 8);
    const bucket = bins.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
    bins.set(key, bucket);
    if (chromaDistance(color, expectedYcc) <= CHROMA_OUT) {
      expectedCount++; expectedR += r; expectedG += g; expectedB += b;
    }
    total++;
  };

  const cornerWidth = Math.max(1, Math.min(width, Math.floor(width / 5)));
  const cornerHeight = Math.max(1, Math.min(height, Math.floor(height / 5)));
  const visitRect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) visit(x, y);
  };
  visitRect(0, 0, cornerWidth, cornerHeight);
  visitRect(width - cornerWidth, 0, width, cornerHeight);
  visitRect(0, height - cornerHeight, cornerWidth, height);
  visitRect(width - cornerWidth, height - cornerHeight, width, height);
  for (let x = 0; x < width; x++) { visit(x, 0); if (height > 1) visit(x, height - 1); }
  for (let y = 0; y < height; y++) { visit(0, y); if (width > 1) visit(width - 1, y); }

  if (expectedCount >= total * 0.12) {
    return [Math.round(expectedR / expectedCount), Math.round(expectedG / expectedCount), Math.round(expectedB / expectedCount)] as [number, number, number];
  }
  let best: { count: number; r: number; g: number; b: number } | undefined;
  for (const bucket of bins.values()) if (!best || bucket.count > best.count) best = bucket;
  return best
    ? [Math.round(best.r / best.count), Math.round(best.g / best.count), Math.round(best.b / best.count)] as [number, number, number]
    : expected;
}

function cleanupAlpha(image: ImageData) {
  const { width, height, data } = image;
  const clear: number[] = [];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = y * width + x;
    const alpha = data[index * 4 + 3];
    if (alpha < 8) data[index * 4 + 3] = 0;
    else if (alpha > 247) data[index * 4 + 3] = 255;
    if (alpha <= 32) continue;
    let opaqueNeighbors = 0;
    for (const neighbor of [index - 1, index + 1, index - width, index + width]) {
      if (data[neighbor * 4 + 3] > 32) opaqueNeighbors++;
    }
    if (opaqueNeighbors === 0) clear.push(index);
  }
  clear.forEach((index) => { data[index * 4 + 3] = 0; });
}

// Straight-alpha images keep RGB values even where alpha is almost zero.
// Chroma-key pixels in that hidden RGB otherwise become rare, high-contrast
// palette samples and reappear as a colored fringe after quantization. Extend
// nearby foreground RGB into the translucent edge while preserving its alpha.
function repairTransparentEdgeRgb(image: ImageData) {
  const { width, height, data } = image;
  for (let pass = 0; pass < 3; pass++) {
    const source = new Uint8ClampedArray(data);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const offset = index * 4;
      const alpha = source[offset + 3];
      if (alpha === 0) {
        data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0;
        continue;
      }
      if (alpha >= 250) continue;
      let weight = 0; let r = 0; let g = 0; let b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
        const neighbor = ((y + dy) * width + x + dx) * 4;
        const neighborAlpha = source[neighbor + 3];
        if (neighborAlpha <= alpha + 12) continue;
        const contribution = neighborAlpha / 255 / (Math.abs(dx) + Math.abs(dy) === 2 ? Math.SQRT2 : 1);
        weight += contribution;
        r += source[neighbor] * contribution;
        g += source[neighbor + 1] * contribution;
        b += source[neighbor + 2] * contribution;
      }
      if (weight > 0) {
        data[offset] = Math.round(r / weight);
        data[offset + 1] = Math.round(g / weight);
        data[offset + 2] = Math.round(b / weight);
      }
    }
  }
}

export function removeChromaBackground(source: ImageData, keyName: ChromaKeyName): ChromaMatteResult {
  const expectedKey = CHROMA_KEY_RGB[keyName];
  const detectedKey = detectBackground(source, expectedKey);
  const keyYcc = toYCbCr(...detectedKey);
  const expectedYcc = toYCbCr(...expectedKey);
  const keyDistance = chromaDistance(keyYcc, expectedYcc);
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const { width, height, data } = output;
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (index < 0 || index >= pixelCount || visited[index]) return;
    const offset = index * 4;
    const color = toYCbCr(source.data[offset], source.data[offset + 1], source.data[offset + 2]);
    if (chromaDistance(color, keyYcc) > DESPILL_BAND) return;
    visited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index < pixelCount - width) enqueue(index + width);
  }

  const keyVectorCb = keyYcc.cb - 128;
  const keyVectorCr = keyYcc.cr - 128;
  const keyLength = Math.hypot(keyVectorCb, keyVectorCr);
  for (let index = 0; index < pixelCount; index++) {
    const offset = index * 4;
    const color = toYCbCr(data[offset], data[offset + 1], data[offset + 2]);
    const distance = chromaDistance(color, keyYcc);
    // Four-connected flood fill intentionally protects similar colors inside
    // the subject, but pixel-art outlines can enclose genuine background holes
    // (for example between an arm and torso). The controlled generation
    // contract forbids the exact key in the subject, so exact/near-exact key
    // pixels are safe to clear even when that pocket is not edge-connected.
    if (!visited[index]) {
      if (distance <= CHROMA_IN) {
        data[offset + 3] = 0;
      } else if (keyLength > 1 && distance < DESPILL_BAND) {
        const pixelCb = color.cb - 128;
        const pixelCr = color.cr - 128;
        const projection = (pixelCb * keyVectorCb + pixelCr * keyVectorCr) / keyLength;
        if (projection > 0) {
          const falloff = smoothstep(0, 1, (DESPILL_BAND - distance) / DESPILL_BAND);
          const weight = (0.35 + 0.65 * falloff) * DESPILL_SCALE;
          color.cb = 128 + pixelCb - (keyVectorCb / keyLength) * projection * weight;
          color.cr = 128 + pixelCr - (keyVectorCr / keyLength) * projection * weight;
          const [r, g, b] = fromYCbCr(color);
          data[offset] = r; data[offset + 1] = g; data[offset + 2] = b;
        }
      }
      continue;
    }
    const originalAlpha = data[offset + 3];
    let alpha = smoothstep(CHROMA_IN, CHROMA_OUT, distance);
    if (distance <= FLOOD_TOLERANCE) alpha = Math.min(alpha, smoothstep(CHROMA_IN, FLOOD_TOLERANCE, distance));
    data[offset + 3] = Math.round(originalAlpha * alpha);
    if (alpha > 0 && keyLength > 1 && distance < DESPILL_BAND) {
      const pixelCb = color.cb - 128;
      const pixelCr = color.cr - 128;
      const projection = (pixelCb * keyVectorCb + pixelCr * keyVectorCr) / keyLength;
      if (projection > 0) {
        const falloff = smoothstep(0, 1, (DESPILL_BAND - distance) / DESPILL_BAND);
        const weight = (0.35 + 0.65 * falloff) * DESPILL_SCALE;
        color.cb = 128 + pixelCb - (keyVectorCb / keyLength) * projection * weight;
        color.cr = 128 + pixelCr - (keyVectorCr / keyLength) * projection * weight;
        const [r, g, b] = fromYCbCr(color);
        data[offset] = r; data[offset + 1] = g; data[offset + 2] = b;
      }
    }
  }
  cleanupAlpha(output);
  repairTransparentEdgeRgb(output);

  let opaque = 0;
  let residue = 0;
  let edgeOpaque = 0;
  let edgeTotal = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const offset = index * 4;
    const alpha = data[offset + 3];
    if (alpha > 16) {
      opaque++;
      const color = toYCbCr(data[offset], data[offset + 1], data[offset + 2]);
      if (chromaDistance(color, expectedYcc) < 55) residue++;
    }
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      edgeTotal++;
      if (alpha > 16) edgeOpaque++;
    }
  }
  const opaqueRatio = opaque / Math.max(1, pixelCount);
  const keyResidueRatio = residue / Math.max(1, pixelCount);
  const edgeContactRatio = edgeOpaque / Math.max(1, edgeTotal);
  const checks: Array<[boolean, string]> = [
    [keyDistance <= CHROMA_OUT, "Generated background does not match the selected chroma key"],
    [opaqueRatio >= 0.02, "Chroma removal left too little foreground"],
    [opaqueRatio <= 0.60, "Too much background remains after chroma removal"],
    [keyResidueRatio <= 0.025, "Chroma color residue is still visible"],
    [edgeContactRatio <= 0.02, "The subject or background touches the image edge"],
  ];
  const failed = checks.find(([passes]) => !passes);
  return {
    imageData: output,
    stats: {
      expectedKey, detectedKey, keyDistance, opaqueRatio, keyResidueRatio, edgeContactRatio,
      success: !failed,
      reason: failed?.[1],
    },
  };
}

export function validateExternalVideoReference(source: ImageData, keyName: ChromaKeyName): VideoReferenceAssessment {
  const matte = removeChromaBackground(source, keyName);
  const expected = CHROMA_KEY_RGB[keyName];
  const pixelCount = Math.max(1, source.width * source.height);
  let opaquePixels = 0;
  let edgePixels = 0;
  let exactEdgePixels = 0;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const offset = (y * source.width + x) * 4;
    if (source.data[offset + 3] >= 254) opaquePixels++;
    if (x === 0 || y === 0 || x === source.width - 1 || y === source.height - 1) {
      edgePixels++;
      const exact = source.data[offset + 3] >= 254 &&
        Math.abs(source.data[offset] - expected[0]) <= 4 &&
        Math.abs(source.data[offset + 1] - expected[1]) <= 4 &&
        Math.abs(source.data[offset + 2] - expected[2]) <= 4;
      if (exact) exactEdgePixels++;
    }
  }
  const fullyOpaque = opaquePixels === pixelCount;
  const bounds = alphaBounds(matte.imageData);
  const minimumMarginRatio = bounds ? Math.max(0, Math.min(
    bounds.minX / Math.max(1, source.width),
    bounds.minY / Math.max(1, source.height),
    (source.width - 1 - bounds.maxX) / Math.max(1, source.width),
    (source.height - 1 - bounds.maxY) / Math.max(1, source.height),
  )) : 0;
  const exactEdgeRatio = exactEdgePixels / Math.max(1, edgePixels);
  const requiresNormalization = exactEdgeRatio < 0.98;
  const failures: string[] = [];
  if (!matte.stats.success) failures.push(matte.stats.reason || "The controlled chroma background could not be removed safely");
  if (!fullyOpaque) failures.push("The source image contains transparency; video models need the original opaque chroma image");
  if (exactEdgeRatio < 0.98) failures.push("The image border is not the exact selected chroma color on every side");
  if (minimumMarginRatio < 0.05) failures.push("The subject needs more empty chroma margin from every image edge");
  const warnings: string[] = [];
  if (Math.min(source.width, source.height) < 512) warnings.push("Use at least 512×512 for a more stable video reference");
  const aspectRatio = source.width / Math.max(1, source.height);
  if (aspectRatio < 0.9 || aspectRatio > 1.1) warnings.push("A square source image is recommended for sprite animation");
  if (minimumMarginRatio >= 0.05 && minimumMarginRatio < 0.12) warnings.push("More empty margin around the subject may improve video stability");
  return {
    pixelProcessingReady: matte.stats.success,
    videoReady: matte.stats.success && fullyOpaque && exactEdgeRatio >= 0.98 && minimumMarginRatio >= 0.05,
    normalizationReady: matte.stats.success && fullyOpaque && matte.stats.edgeContactRatio <= 0.02 && minimumMarginRatio >= 0.05,
    requiresNormalization,
    detectedKey: matte.stats.detectedKey,
    opaqueRatio: matte.stats.opaqueRatio,
    edgeContactRatio: matte.stats.edgeContactRatio,
    minimumMarginRatio,
    fullyOpaque,
    warnings,
    failures,
  };
}

export function prepareExternalVideoReference(source: ImageData, keyName: ChromaKeyName): PreparedVideoReferenceResult {
  const initial = validateExternalVideoReference(source, keyName);
  if (!initial.normalizationReady) {
    return {
      imageData: new ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
      assessment: initial,
      success: false,
      reason: initial.failures[0] || "The source image cannot be normalized safely for video",
    };
  }
  if (!initial.requiresNormalization) {
    return {
      imageData: new ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
      assessment: initial,
      success: initial.videoReady,
      reason: initial.videoReady ? undefined : initial.failures[0],
    };
  }

  const matte = removeChromaBackground(source, keyName).imageData;
  const key = CHROMA_KEY_RGB[keyName];
  const output = new ImageData(new Uint8ClampedArray(source.data.length), source.width, source.height);
  for (let offset = 0; offset < matte.data.length; offset += 4) {
    const alpha = matte.data[offset + 3] / 255;
    output.data[offset] = Math.round(matte.data[offset] * alpha + key[0] * (1 - alpha));
    output.data[offset + 1] = Math.round(matte.data[offset + 1] * alpha + key[1] * (1 - alpha));
    output.data[offset + 2] = Math.round(matte.data[offset + 2] * alpha + key[2] * (1 - alpha));
    output.data[offset + 3] = 255;
  }
  const assessment = validateExternalVideoReference(output, keyName);
  return {
    imageData: output,
    assessment,
    success: assessment.videoReady,
    reason: assessment.videoReady ? undefined : assessment.failures[0] || "The normalized reference did not pass the video quality check",
  };
}

// Backward-compatible connected RGB keyer retained for callers that supply custom colors.
export function chromaKeyConnected(source: ImageData, options: ChromaOptions) {
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const { width, height, data } = output;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (visited[index]) return;
    const p = index * 4;
    const distance = Math.hypot(data[p] - options.key[0], data[p + 1] - options.key[1], data[p + 2] - options.key[2]);
    if (distance > options.tolerance + options.feather) return;
    visited[index] = 1; queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++]; const x = index % width;
    if (x > 0) enqueue(index - 1); if (x < width - 1) enqueue(index + 1);
    if (index >= width) enqueue(index - width); if (index < width * height - width) enqueue(index + width);
  }
  for (let index = 0; index < visited.length; index++) {
    if (!visited[index]) continue;
    const p = index * 4;
    const distance = Math.hypot(data[p] - options.key[0], data[p + 1] - options.key[1], data[p + 2] - options.key[2]);
    data[p + 3] = Math.min(data[p + 3], distance <= options.tolerance ? 0 : Math.round(255 * Math.min(1, (distance - options.tolerance) / Math.max(1, options.feather))));
  }
  return output;
}

export function dominantPalette(frames: ImageData[], maxColors: number) {
  return derivePerceptualPalette(frames, maxColors);
}

export function applyPalette(source: ImageData, palette: [number, number, number][]) {
  return applyPerceptualPalette(source, palette);
}

export function alphaBounds(image: ImageData) {
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1, mass = 0, weightedX = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const alpha = image.data[(y * image.width + x) * 4 + 3];
    if (alpha < 16) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    mass += alpha; weightedX += x * alpha;
  }
  return maxX < minX ? null : { minX, minY, maxX, maxY, centroidX: weightedX / mass, baseline: maxY };
}

export function frameDifference(a: ImageData, b: ImageData) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let total = 0;
  for (let p = 0; p < a.data.length; p += 16) total += Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]) + Math.abs(a.data[p + 3] - b.data[p + 3]);
  return total / ((a.data.length / 16) * 1020);
}

async function loadImage(url: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Could not decode image")); image.src = url; });
  return image;
}

export async function processImageUrl(url: string, width: number, height: number, paletteSize = 24, options: PixelProcessOptions = {}): Promise<PixelProcessResult> {
  const image = await loadImage(url);
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = image.naturalWidth; sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
  sourceContext.drawImage(image, 0, 0);
  let sourceData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  let chroma: ChromaMatteStats | undefined;
  if (options.chromaKey) {
    const matte = removeChromaBackground(sourceData, options.chromaKey);
    chroma = matte.stats;
    if (!chroma.success) return { canvas: sourceCanvas, chroma };
    sourceData = matte.imageData;
    sourceContext.putImageData(sourceData, 0, 0);
  }

  const processed = pixelateImageData(sourceData, width, height, paletteSize, { gridHint: options.gridHint });
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d", { willReadFrequently: true })!.putImageData(processed.imageData, 0, 0);
  return { canvas, chroma, analysis: { grid: processed.grid, gridRecovered: processed.gridRecovered } };
}

export async function imageUrlToCanvas(url: string, width: number, height: number, paletteSize = 24) {
  return (await processImageUrl(url, width, height, paletteSize)).canvas;
}
