export type RGB = [number, number, number];

export interface PixelGridDetection {
  detected: boolean;
  stepX: number;
  stepY: number;
  columns: number;
  rows: number;
  confidence: number;
  /** Strength of the paired peaks in PerfectPixel's 2D FFT projection. */
  fftConfidence?: number;
  /** Whether the raw FFT proposal passed PerfectPixel's cell-size checks. */
  fftValid?: boolean;
  /** Whether PerfectPixel used its Sobel-gradient grid-size fallback. */
  gradientFallbackUsed?: boolean;
  /** Sobel-aligned grid width before PerfectPixel's optional square correction. */
  alignedColumns?: number;
  /** Sobel-aligned grid height before PerfectPixel's optional square correction. */
  alignedRows?: number;
  /** PerfectPixel's final one-cell square correction, when applied. */
  squareAdjustment?: "remove-column" | "add-column" | "remove-row" | "add-row";
  /** Rigid FFT-spaced source-cell boundaries with one Sobel-selected X phase. */
  xBoundaries?: number[];
  /** Rigid FFT-spaced source-cell boundaries with one Sobel-selected Y phase. */
  yBoundaries?: number[];
}

export interface PixelArtProcessOptions {
  recoverGrid?: boolean;
  gridHint?: PixelGridDetection;
  quantize?: boolean;
}

export interface PixelArtProcessResult {
  imageData: ImageData;
  grid: PixelGridDetection;
  gridRecovered: boolean;
  palette: RGB[];
}

export interface AnimationSizeEstimate {
  /** Median number of source-image pixels represented by one apparent art pixel. */
  sourcePixelStep: number;
  /** Apparent source-art grid before Pixelate's 2× density recommendation. */
  detectedWidth: number;
  detectedHeight: number;
  /** Recommended logical grid after doubling, before snapping to a preset. */
  doubledWidth: number;
  doubledHeight: number;
  /** Nearest supported square animation output. */
  preset: number;
  /** Number of representative frames that produced a usable estimate. */
  samples: number;
}

interface Vec3 { 0: number; 1: number; 2: number }
interface WeightedPoint { value: Vec3; weight: number }
interface HistogramEntry { count: number; r: number; g: number; b: number }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const clampByte = (value: number) => clamp(Math.round(value), 0, 255);
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function makeImageData(width: number, height: number) {
  return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
}

function srgbToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(Math.max(0, value), 1 / 2.4) - 0.055;
  return clampByte(encoded * 255);
}

function rgbToOklab(r: number, g: number, b: number): Vec3 {
  const rl = srgbToLinear(r); const gl = srgbToLinear(g); const bl = srgbToLinear(b);
  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;
  const lRoot = Math.cbrt(l); const mRoot = Math.cbrt(m); const sRoot = Math.cbrt(s);
  return {
    0: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    2: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
}

function oklabToRgb(value: Vec3): RGB {
  const lRoot = value[0] + 0.3963377774 * value[1] + 0.2158037573 * value[2];
  const mRoot = value[0] - 0.1055613458 * value[1] - 0.0638541728 * value[2];
  const sRoot = value[0] - 0.0894841775 * value[1] - 1.291485548 * value[2];
  const l = lRoot ** 3; const m = mRoot ** 3; const s = sRoot ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function toWorking(color: RGB, useOklab: boolean): Vec3 {
  return useOklab ? rgbToOklab(...color) : { 0: color[0], 1: color[1], 2: color[2] };
}

function fromWorking(value: Vec3, useOklab: boolean): RGB {
  return useOklab ? oklabToRgb(value) : [clampByte(value[0]), clampByte(value[1]), clampByte(value[2])];
}

const dist2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function buildHistogram(frames: ImageData[]) {
  const histogram = new Map<number, HistogramEntry>();
  const totalPixels = frames.reduce((sum, frame) => sum + frame.width * frame.height, 0);
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / 180_000)));
  for (const frame of frames) {
    const { width, height, data } = frame;
    for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3] / 255;
      // Translucent matte fringes should inherit the foreground palette, not
      // create their own rare chroma-derived colors. Only stable foreground
      // samples are allowed to steer palette construction.
      if (alpha < 0.5) continue;
      const r = data[offset]; const g = data[offset + 1]; const b = data[offset + 2];
      const right = x + stride < width ? offset + stride * 4 : offset;
      const down = y + stride < height ? offset + stride * width * 4 : offset;
      const localContrast = Math.max(
        Math.abs(luminance(r, g, b) - luminance(data[right], data[right + 1], data[right + 2])),
        Math.abs(luminance(r, g, b) - luminance(data[down], data[down + 1], data[down + 2])),
      ) / 255;
      const weight = alpha * alpha * (1 + 1.75 * localContrast);
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const entry = histogram.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      entry.count += weight; entry.r += r * weight; entry.g += g * weight; entry.b += b * weight;
      histogram.set(key, entry);
    }
  }
  return [...histogram.values()].map((entry) => ({
    color: [entry.r / entry.count, entry.g / entry.count, entry.b / entry.count] as RGB,
    weight: entry.count,
  }));
}

function weightedMean(points: WeightedPoint[]): Vec3 {
  let weight = 0; let x = 0; let y = 0; let z = 0;
  for (const point of points) {
    weight += point.weight;
    x += point.value[0] * point.weight; y += point.value[1] * point.weight; z += point.value[2] * point.weight;
  }
  const divisor = Math.max(weight, 1e-9);
  return { 0: x / divisor, 1: y / divisor, 2: z / divisor };
}

function principalAxis(points: WeightedPoint[], mean: Vec3): Vec3 {
  let xx = 0; let xy = 0; let xz = 0; let yy = 0; let yz = 0; let zz = 0; let total = 0;
  for (const point of points) {
    const x = point.value[0] - mean[0]; const y = point.value[1] - mean[1]; const z = point.value[2] - mean[2];
    xx += point.weight * x * x; xy += point.weight * x * y; xz += point.weight * x * z;
    yy += point.weight * y * y; yz += point.weight * y * z; zz += point.weight * z * z; total += point.weight;
  }
  if (total > 0) { xx /= total; xy /= total; xz /= total; yy /= total; yz /= total; zz /= total; }
  let axis: Vec3 = { 0: 1, 1: 1, 2: 1 };
  for (let iteration = 0; iteration < 24; iteration++) {
    const next: Vec3 = {
      0: xx * axis[0] + xy * axis[1] + xz * axis[2],
      1: xy * axis[0] + yy * axis[1] + yz * axis[2],
      2: xz * axis[0] + yz * axis[1] + zz * axis[2],
    };
    const length = Math.hypot(next[0], next[1], next[2]);
    if (length < 1e-9) return { 0: 1, 1: 0, 2: 0 };
    axis = { 0: next[0] / length, 1: next[1] / length, 2: next[2] / length };
  }
  return axis;
}

function splitPoints(points: WeightedPoint[]) {
  const mean = weightedMean(points);
  const axis = principalAxis(points, mean);
  const sorted = [...points].sort((a, b) => {
    const ap = (a.value[0] - mean[0]) * axis[0] + (a.value[1] - mean[1]) * axis[1] + (a.value[2] - mean[2]) * axis[2];
    const bp = (b.value[0] - mean[0]) * axis[0] + (b.value[1] - mean[1]) * axis[1] + (b.value[2] - mean[2]) * axis[2];
    return ap - bp;
  });
  const total = sorted.reduce((sum, point) => sum + point.weight, 0);
  let accumulated = 0; let cut = 1;
  for (let index = 0; index < sorted.length - 1; index++) {
    accumulated += sorted[index].weight;
    if (accumulated >= total / 2) { cut = index + 1; break; }
  }
  return [sorted.slice(0, cut), sorted.slice(cut)] as const;
}

function boxError(points: WeightedPoint[]) {
  const mean = weightedMean(points);
  return points.reduce((sum, point) => sum + point.weight * dist2(point.value, mean), 0);
}

export function derivePerceptualPalette(frames: ImageData[], maxColors: number): RGB[] {
  const count = clamp(Math.round(maxColors), 2, 256);
  const histogram = buildHistogram(frames);
  if (!histogram.length) return [[0, 0, 0], [255, 255, 255]];
  if (histogram.length <= count) return histogram.map((entry) => entry.color.map(clampByte) as RGB);
  const useOklab = count > 48;
  const points = histogram.map((entry) => ({ value: toWorking(entry.color, useOklab), weight: entry.weight }));
  const boxes: WeightedPoint[][] = [points];
  while (boxes.length < count) {
    let best = -1; let bestError = -1;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      const error = boxError(box);
      if (error > bestError) { best = index; bestError = error; }
    });
    if (best < 0) break;
    const [left, right] = splitPoints(boxes[best]);
    if (!left.length || !right.length) break;
    boxes[best] = left; boxes.push(right);
  }
  let centroids = boxes.map(weightedMean);
  for (let iteration = 0; iteration < 8; iteration++) {
    const sums = centroids.map(() => ({ 0: 0, 1: 0, 2: 0 } as Vec3));
    const weights = new Float64Array(centroids.length);
    for (const point of points) {
      let best = 0; let bestDistance = dist2(point.value, centroids[0]);
      for (let index = 1; index < centroids.length; index++) {
        const distance = dist2(point.value, centroids[index]);
        if (distance < bestDistance) { best = index; bestDistance = distance; }
      }
      sums[best][0] += point.value[0] * point.weight;
      sums[best][1] += point.value[1] * point.weight;
      sums[best][2] += point.value[2] * point.weight;
      weights[best] += point.weight;
    }
    centroids = centroids.map((centroid, index) => weights[index] > 0 ? ({
      0: sums[index][0] / weights[index], 1: sums[index][1] / weights[index], 2: sums[index][2] / weights[index],
    }) : centroid);
  }
  return centroids.map((centroid) => fromWorking(centroid, useOklab));
}

export function applyPerceptualPalette(source: ImageData, palette: RGB[]) {
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  if (!palette.length) return output;
  const useOklab = palette.length > 48;
  const workingPalette = palette.map((color) => toWorking(color, useOklab));
  for (let offset = 0; offset < output.data.length; offset += 4) {
    if (output.data[offset + 3] < 16) { output.data[offset] = 0; output.data[offset + 1] = 0; output.data[offset + 2] = 0; continue; }
    const value = toWorking([output.data[offset], output.data[offset + 1], output.data[offset + 2]], useOklab);
    let best = 0; let bestDistance = dist2(value, workingPalette[0]);
    for (let index = 1; index < workingPalette.length; index++) {
      const distance = dist2(value, workingPalette[index]);
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    }
    output.data[offset] = palette[best][0]; output.data[offset + 1] = palette[best][1]; output.data[offset + 2] = palette[best][2];
  }
  return output;
}

function pixelDifference(data: Uint8ClampedArray, a: number, b: number) {
  const alphaA = data[a + 3] / 255; const alphaB = data[b + 3] / 255;
  const alpha = Math.min(alphaA, alphaB);
  const color = Math.sqrt(
    0.30 * (data[a] - data[b]) ** 2 +
    0.59 * (data[a + 1] - data[b + 1]) ** 2 +
    0.11 * (data[a + 2] - data[b + 2]) ** 2
  ) / 255;
  return Math.abs(alphaA - alphaB) + alpha * color;
}

/** In-place radix-2 FFT, used as the fast base case of the mixed-radix FFT. */
function fftInPlace(real: Float64Array, imaginary: Float64Array) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index++) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    const angle = -2 * Math.PI / size;
    const stepReal = Math.cos(angle); const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < length; offset += size) {
      let phaseReal = 1; let phaseImaginary = 0;
      for (let index = 0; index < size / 2; index++) {
        const even = offset + index; const odd = even + size / 2;
        const oddReal = real[odd] * phaseReal - imaginary[odd] * phaseImaginary;
        const oddImaginary = real[odd] * phaseImaginary + imaginary[odd] * phaseReal;
        real[odd] = real[even] - oddReal; imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal; imaginary[even] += oddImaginary;
        const nextReal = phaseReal * stepReal - phaseImaginary * stepImaginary;
        phaseImaginary = phaseReal * stepImaginary + phaseImaginary * stepReal;
        phaseReal = nextReal;
      }
    }
  }
}

function smallestFactor(value: number) {
  if (value % 2 === 0) return 2;
  for (let factor = 3; factor * factor <= value; factor += 2) if (value % factor === 0) return factor;
  return value;
}

/**
 * Arbitrary-length forward FFT. PerfectPixel transforms the source at its
 * native dimensions, so padding to a power of two would move its frequency
 * bins and no longer reproduce the reference algorithm.
 */
function fftForward(realInput: Float64Array, imaginaryInput?: Float64Array): [Float64Array, Float64Array] {
  const length = realInput.length;
  const real = new Float64Array(realInput); const imaginary = imaginaryInput ? new Float64Array(imaginaryInput) : new Float64Array(length);
  if (length <= 1) return [real, imaginary];
  if ((length & (length - 1)) === 0) { fftInPlace(real, imaginary); return [real, imaginary]; }

  const factor = smallestFactor(length); const partLength = length / factor;
  const parts: Array<[Float64Array, Float64Array]> = [];
  for (let part = 0; part < factor; part++) {
    const partReal = new Float64Array(partLength); const partImaginary = new Float64Array(partLength);
    for (let index = 0; index < partLength; index++) {
      partReal[index] = realInput[index * factor + part];
      partImaginary[index] = imaginaryInput?.[index * factor + part] || 0;
    }
    parts.push(fftForward(partReal, partImaginary));
  }
  for (let frequency = 0; frequency < length; frequency++) {
    const subFrequency = frequency % partLength;
    let sumReal = 0; let sumImaginary = 0;
    for (let part = 0; part < factor; part++) {
      const angle = -2 * Math.PI * part * frequency / length;
      const cosine = Math.cos(angle); const sine = Math.sin(angle);
      const partReal = parts[part][0][subFrequency]; const partImaginary = parts[part][1][subFrequency];
      sumReal += partReal * cosine - partImaginary * sine;
      sumImaginary += partReal * sine + partImaginary * cosine;
    }
    real[frequency] = sumReal; imaginary[frequency] = sumImaginary;
  }
  return [real, imaginary];
}

function grayscale(source: ImageData) {
  const gray = new Float64Array(source.width * source.height);
  for (let index = 0; index < gray.length; index++) {
    const offset = index * 4;
    gray[index] = 0.299 * source.data[offset] + 0.587 * source.data[offset + 1] + 0.114 * source.data[offset + 2];
  }
  return gray;
}

function normalize(values: Float64Array) {
  let minimum = Infinity; let maximum = -Infinity;
  for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  const range = maximum - minimum;
  if (range < 1e-8) return new Float64Array(values.length);
  const output = new Float64Array(values.length);
  for (let index = 0; index < values.length; index++) output[index] = (values[index] - minimum) / range;
  return output;
}

/** Exact browser port of PerfectPixel's fft2 -> fftshift -> 1-log magnitude. */
function perfectPixelFftProjections(source: ImageData) {
  const { width, height } = source; const gray = grayscale(source);
  const real = new Float64Array(gray); const imaginary = new Float64Array(gray.length);
  for (let y = 0; y < height; y++) {
    const [rowReal, rowImaginary] = fftForward(real.subarray(y * width, (y + 1) * width));
    real.set(rowReal, y * width); imaginary.set(rowImaginary, y * width);
  }
  const columnReal = new Float64Array(height); const columnImaginary = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) { const index = y * width + x; columnReal[y] = real[index]; columnImaginary[y] = imaginary[index]; }
    const [resultReal, resultImaginary] = fftForward(columnReal, columnImaginary);
    for (let y = 0; y < height; y++) { const index = y * width + x; real[index] = resultReal[y]; imaginary[index] = resultImaginary[y]; }
  }

  const inverseLogMagnitude = new Float64Array(real.length); let minimum = Infinity; let maximum = -Infinity;
  for (let index = 0; index < real.length; index++) {
    const value = 1 - Math.log1p(Math.hypot(real[index], imaginary[index]));
    inverseLogMagnitude[index] = value; minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
  }
  const range = Math.max(1e-8, maximum - minimum);
  const rowSum = new Float64Array(height); const columnSum = new Float64Array(width);
  const bandRow = Math.floor(width / 2); const bandColumn = Math.floor(height / 2);
  const firstX = Math.floor(width / 2) - bandRow; const lastX = Math.floor(width / 2) + bandRow;
  const firstY = Math.floor(height / 2) - bandColumn; const lastY = Math.floor(height / 2) + bandColumn;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const shiftedY = (y + Math.floor(height / 2)) % height;
    const shiftedX = (x + Math.floor(width / 2)) % width;
    const value = (inverseLogMagnitude[y * width + x] - minimum) / range;
    if (x >= firstX && x < lastX) rowSum[shiftedY] += value;
    if (y >= firstY && y < lastY) columnSum[shiftedX] += value;
  }
  return { row: normalize(rowSum), column: normalize(columnSum) };
}

function smooth1d(values: Float64Array, kernelSize = 17) {
  const size = kernelSize % 2 ? kernelSize : kernelSize + 1; const radius = Math.floor(size / 2); const sigma = size / 6;
  const kernel = new Float64Array(size); let kernelSum = 0;
  for (let index = 0; index < size; index++) { const x = index - radius; kernel[index] = Math.exp(-(x * x) / (2 * sigma * sigma)); kernelSum += kernel[index]; }
  for (let index = 0; index < size; index++) kernel[index] /= kernelSum + 1e-8;
  const output = new Float64Array(values.length);
  for (let index = 0; index < values.length; index++) for (let k = 0; k < size; k++) {
    const sourceIndex = index + k - radius;
    if (sourceIndex >= 0 && sourceIndex < values.length) output[index] += values[sourceIndex] * kernel[k];
  }
  return output;
}

interface PeakDetection { scale: number; score: number }

/** Faithful port of PerfectPixel's paired-peak search. */
function detectPerfectPixelPeak(projection: Float64Array, peakWidth = 6, relativeThreshold = 0.35, minimumDistance = 6): PeakDetection | undefined {
  const center = Math.floor(projection.length / 2); let maximum = 0;
  for (const value of projection) maximum = Math.max(maximum, value);
  if (maximum < 1e-6) return undefined;
  const threshold = maximum * relativeThreshold;
  const candidates: Array<{ index: number; score: number }> = [];
  for (let index = 1; index < projection.length - 1; index++) {
    let isPeak = true;
    for (let distance = 1; distance < peakWidth; distance++) {
      if (index - distance < 0 || index + distance >= projection.length) continue;
      if (projection[index - distance + 1] < projection[index - distance] || projection[index + distance - 1] < projection[index + distance]) { isPeak = false; break; }
    }
    if (!isPeak || projection[index] < threshold) continue;
    let climb = 0; let fall = 0;
    for (let position = index; position > 0; position--) {
      if (projection[position] > projection[position - 1]) climb = Math.abs(projection[index] - projection[position - 1]); else break;
    }
    for (let position = index; position < projection.length - 1; position++) {
      if (projection[position] > projection[position + 1]) fall = Math.abs(projection[index] - projection[position + 1]); else break;
    }
    candidates.push({ index, score: Math.max(climb, fall) });
  }
  const left = candidates.filter((candidate) => candidate.index < center - minimumDistance && candidate.index > center * 0.25).sort((a, b) => b.score - a.score);
  const right = candidates.filter((candidate) => candidate.index > center + minimumDistance && candidate.index < center * 1.75).sort((a, b) => b.score - a.score);
  if (!left.length || !right.length) return undefined;
  return {
    scale: Math.abs(right[0].index - left[0].index) / 2,
    score: clamp((left[0].score + right[0].score) / Math.max(2 * maximum, 1e-9), 0, 1),
  };
}

function reflect(value: number, length: number) {
  if (length <= 1) return 0;
  if (value < 0) return -value;
  if (value >= length) return 2 * length - value - 2;
  return value;
}

/** PerfectPixel's 3x3 Sobel with reflect padding, summed by axis. */
function sobelAxisSums(source: ImageData) {
  const { width, height } = source; const gray = grayscale(source);
  const xSum = new Float64Array(width); const ySum = new Float64Array(height);
  const kernelX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
  const kernelY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let gradientX = 0; let gradientY = 0;
    for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
      const value = gray[reflect(y + ky, height) * width + reflect(x + kx, width)];
      gradientX += value * kernelX[ky + 1][kx + 1]; gradientY += value * kernelY[ky + 1][kx + 1];
    }
    xSum[x] += Math.abs(gradientX); ySum[y] += Math.abs(gradientY);
  }
  return { x: xSum, y: ySum };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Sprite Fusion Pixel Snapper-style gradient peak spacing on a quantized frame. */
function estimateQuantizedSourcePixelStep(source: ImageData) {
  if (source.width < 8 || source.height < 8) return undefined;
  const profileX = new Float64Array(source.width); const profileY = new Float64Array(source.height);
  const gray = (x: number, y: number) => {
    const offset = (y * source.width + x) * 4;
    if (source.data[offset + 3] < 16) return 0;
    return 0.299 * source.data[offset] + 0.587 * source.data[offset + 1] + 0.114 * source.data[offset + 2];
  };
  for (let y = 0; y < source.height; y++) for (let x = 1; x < source.width - 1; x++) {
    profileX[x] += Math.abs(gray(x + 1, y) - gray(x - 1, y));
  }
  for (let x = 0; x < source.width; x++) for (let y = 1; y < source.height - 1; y++) {
    profileY[y] += Math.abs(gray(x, y + 1) - gray(x, y - 1));
  }
  const estimateAxis = (profile: Float64Array) => {
    let maximum = 0;
    for (const value of profile) maximum = Math.max(maximum, value);
    if (maximum <= 0) return undefined;
    const threshold = maximum * 0.2; const peaks: number[] = [];
    for (let index = 1; index < profile.length - 1; index++) {
      // Select the trailing edge of a flat two-sample gradient peak. Strict
      // maxima alone miss ideal nearest-neighbor pixel boundaries.
      if (profile[index] < threshold || profile[index] < profile[index - 1] || profile[index] <= profile[index + 1]) continue;
      if (!peaks.length || index - peaks[peaks.length - 1] > 3) peaks.push(index);
    }
    if (peaks.length < 2) return undefined;
    return median(peaks.slice(1).map((peak, index) => peak - peaks[index]));
  };
  const stepX = estimateAxis(profileX); const stepY = estimateAxis(profileY);
  if (stepX === undefined && stepY === undefined) return undefined;
  if (stepX === undefined) return stepY;
  if (stepY === undefined) return stepX;
  return Math.max(stepX, stepY) / Math.min(stepX, stepY) > 1.8 ? Math.min(stepX, stepY) : (stepX + stepY) / 2;
}

export function estimateAnimationOutputSize(frames: ImageData[], paletteSize = 24, presets = [32, 64, 128, 256]): AnimationSizeEstimate | undefined {
  if (!frames.length || !presets.length) return undefined;
  const sampleCount = Math.min(5, frames.length);
  const samples = Array.from({ length: sampleCount }, (_, index) => frames[Math.round(index * (frames.length - 1) / Math.max(1, sampleCount - 1))]);
  const palette = derivePerceptualPalette(samples, paletteSize);
  const steps = samples
    .map((frame) => estimateQuantizedSourcePixelStep(applyPerceptualPalette(frame, palette)))
    .filter((step): step is number => step !== undefined && Number.isFinite(step) && step >= 2);
  if (!steps.length) return undefined;
  const sourcePixelStep = median(steps);
  const width = median(samples.map((frame) => frame.width)); const height = median(samples.map((frame) => frame.height));
  const detectedWidth = Math.max(1, Math.round(width / sourcePixelStep));
  const detectedHeight = Math.max(1, Math.round(height / sourcePixelStep));
  const doubledWidth = detectedWidth * 2; const doubledHeight = detectedHeight * 2;
  const requested = Math.max(doubledWidth, doubledHeight);
  const sortedPresets = [...new Set(presets.map((preset) => Math.max(1, Math.round(preset))))].sort((a, b) => a - b);
  const preset = sortedPresets.reduce((best, candidate) => {
    const distance = Math.abs(candidate - requested); const bestDistance = Math.abs(best - requested);
    return distance < bestDistance || (distance === bestDistance && candidate > best) ? candidate : best;
  }, sortedPresets[0]);
  return { sourcePixelStep, detectedWidth, detectedHeight, doubledWidth, doubledHeight, preset, samples: steps.length };
}

/** PerfectPixel's Sobel-gradient fallback for an absent or invalid FFT grid. */
function estimatePerfectPixelGradientGrid(source: ImageData, sums: { x: Float64Array; y: Float64Array }) {
  const findPeaks = (values: Float64Array) => {
    let maximum = 0;
    for (const value of values) maximum = Math.max(maximum, value);
    const threshold = maximum * 0.2;
    const peaks: number[] = [];
    for (let index = 1; index < values.length - 1; index++) {
      if (values[index] > values[index - 1] && values[index] > values[index + 1] && values[index] >= threshold
        && (!peaks.length || index - peaks[peaks.length - 1] >= 4)) peaks.push(index);
    }
    return peaks;
  };
  const peaksX = findPeaks(sums.x); const peaksY = findPeaks(sums.y);
  if (peaksX.length < 4 || peaksY.length < 4) return undefined;
  const intervalsX = peaksX.slice(1).map((peak, index) => peak - peaksX[index]);
  const intervalsY = peaksY.slice(1).map((peak, index) => peak - peaksY[index]);
  return {
    columns: Math.round(source.width / median(intervalsX)),
    rows: Math.round(source.height / median(intervalsY)),
  };
}

function gradientAt(gradient: Float64Array, position: number) {
  const low = Math.floor(position); const high = Math.min(gradient.length - 1, low + 1);
  if (low < 0 || low >= gradient.length) return 0;
  const fraction = position - low;
  return gradient[low] * (1 - fraction) + gradient[high] * fraction;
}

function findBestGrid(origin: number, radius: number, gradient: Float64Array) {
  let best = Math.round(origin); const peaks: Array<{ value: number; index: number }> = [];
  for (let delta = -Math.round(radius); delta <= Math.round(radius); delta++) {
    const candidate = Math.round(origin + delta);
    if (candidate <= 0 || candidate >= gradient.length - 1) continue;
    if (gradient[candidate] > gradient[candidate - 1] && gradient[candidate] > gradient[candidate + 1]) peaks.push({ value: gradient[candidate], index: candidate });
  }
  peaks.sort((a, b) => b.value - a.value);
  if (peaks.length) best = peaks[0].index;
  return best;
}

/** Retain PerfectPixel's center-outward estimate of the visible cell count. */
function estimatePerfectPixelAlignedCells(length: number, proposedCells: number, gradient: Float64Array) {
  const cellSize = length / proposedCells; const coordinates: number[] = [];
  let position = findBestGrid(length / 2, cellSize, gradient);
  while (position < length + cellSize / 2) {
    position = findBestGrid(position, cellSize * 0.25, gradient); coordinates.push(position); position += cellSize;
  }
  position = findBestGrid(length / 2, cellSize, gradient) - cellSize;
  while (position > -cellSize / 2) {
    position = findBestGrid(position, cellSize * 0.25, gradient); coordinates.push(position); position -= cellSize;
  }
  return Math.max(1, coordinates.length - 1);
}

/**
 * Preserve FFT's cell period and let Sobel choose only one global lattice
 * phase. Independently snapping each boundary causes cumulative local warping
 * when a sparse sprite outline is stronger than its underlying pixel grid.
 */
function alignRigidFftBoundaries(length: number, cells: number, gradient: Float64Array) {
  const cellSize = length / cells;
  const searchStep = Math.min(0.25, cellSize / 16);
  let bestPhase = 0; let bestScore = Number.NEGATIVE_INFINITY;
  for (let phase = -cellSize / 2; phase <= cellSize / 2 + searchStep / 2; phase += searchStep) {
    let score = 0; let samples = 0;
    for (let index = 0; index <= cells; index++) {
      const position = phase + index * cellSize;
      if (position <= 0 || position >= length - 1) continue;
      // Square root limits the influence of a single high-contrast silhouette
      // while still rewarding a phase shared by many actual pixel edges.
      score += Math.sqrt(Math.max(0, gradientAt(gradient, position)));
      samples++;
    }
    const normalizedScore = samples ? score / samples : Number.NEGATIVE_INFINITY;
    if (normalizedScore > bestScore) { bestScore = normalizedScore; bestPhase = phase; }
  }
  return Array.from({ length: cells + 1 }, (_, index) => bestPhase + index * cellSize);
}

export function detectPseudoPixelGrid(source: ImageData): PixelGridDetection {
  if (source.width < 24 || source.height < 24) return { detected: false, stepX: 1, stepY: 1, columns: 1, rows: 1, confidence: 0 };
  const projections = perfectPixelFftProjections(source);
  const rowPeak = detectPerfectPixelPeak(smooth1d(projections.row));
  const columnPeak = detectPerfectPixelPeak(smooth1d(projections.column));
  const fftColumns = columnPeak ? Math.round(columnPeak.scale) : 0;
  const fftRows = rowPeak ? Math.round(rowPeak.scale) : 0;
  const fftScore = rowPeak && columnPeak ? Math.min(rowPeak.score, columnPeak.score) : 0;
  let columns = fftColumns; let rows = fftRows;
  let fftValid = Boolean(columns && rows);
  if (fftValid) {
    const cellX = source.width / columns; const cellY = source.height / rows;
    fftValid = Math.min(cellX, cellY) >= 4 && Math.max(cellX, cellY) <= 20
      && cellX / cellY <= 1.5 && cellY / cellX <= 1.5;
  }

  const sobel = sobelAxisSums(source);
  let gradientFallbackUsed = false;
  if (!fftValid) {
    const gradient = estimatePerfectPixelGradientGrid(source, sobel);
    if (!gradient) return {
      detected: false, stepX: 1, stepY: 1, columns: Math.max(1, columns), rows: Math.max(1, rows),
      confidence: 0, fftConfidence: fftScore, fftValid: false, gradientFallbackUsed: true,
    };
    columns = gradient.columns; rows = gradient.rows; gradientFallbackUsed = true;
  }

  const cellX = source.width / columns; const cellY = source.height / rows;
  const pixelSize = cellX / cellY > 1.5 || cellY / cellX > 1.5 ? Math.min(cellX, cellY) : (cellX + cellY) / 2;
  columns = Math.max(1, Math.round(source.width / pixelSize)); rows = Math.max(1, Math.round(source.height / pixelSize));
  // Preserve PerfectPixel's detected resolution, but never use its locally
  // shifted coordinates as sampling geometry. A rigid lattice prevents those
  // local shifts from changing the sprite's proportions.
  const alignedColumns = estimatePerfectPixelAlignedCells(source.width, columns, sobel.x);
  const alignedRows = estimatePerfectPixelAlignedCells(source.height, rows, sobel.y);
  const xBoundaries = alignRigidFftBoundaries(source.width, alignedColumns, sobel.x);
  const yBoundaries = alignRigidFftBoundaries(source.height, alignedRows, sobel.y);
  columns = alignedColumns; rows = alignedRows;
  let squareAdjustment: PixelGridDetection["squareAdjustment"];
  if (Math.abs(columns - rows) === 1) {
    if (columns > rows) {
      if (columns % 2 === 1) { columns--; squareAdjustment = "remove-column"; }
      else { rows++; squareAdjustment = "add-row"; }
    } else if (rows % 2 === 1) { rows--; squareAdjustment = "remove-row"; }
    else { columns++; squareAdjustment = "add-column"; }
  }
  const stepX = source.width / columns; const stepY = source.height / rows;
  return {
    detected: true, stepX, stepY, columns, rows, confidence: fftScore, fftConfidence: fftScore,
    fftValid, gradientFallbackUsed, alignedColumns, alignedRows, squareAdjustment, xBoundaries, yBoundaries,
  };
}

function prepareEdges(source: ImageData) {
  const count = source.width * source.height;
  const opaque = new Uint8Array(count); const outline = new Uint8Array(count); const edge = new Float32Array(count);
  let binaryAlpha = true;
  for (let index = 0; index < count; index++) {
    const alpha = source.data[index * 4 + 3];
    opaque[index] = alpha > 16 ? 1 : 0;
    if (alpha !== 0 && alpha !== 255) binaryAlpha = false;
  }
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const index = y * source.width + x;
    if (!opaque[index]) continue;
    const neighbors = [x > 0 ? index - 1 : -1, x + 1 < source.width ? index + 1 : -1, y > 0 ? index - source.width : -1, y + 1 < source.height ? index + source.width : -1];
    if (neighbors.some((neighbor) => neighbor < 0 || !opaque[neighbor])) outline[index] = 1;
    const offset = index * 4;
    for (const neighbor of neighbors) {
      if (neighbor < 0 || !opaque[neighbor]) continue;
      edge[index] = Math.max(edge[index], pixelDifference(source.data, offset, neighbor * 4));
    }
    if (edge[index] < 0.10) edge[index] = 0;
  }
  return { opaque, outline, edge, binaryAlpha };
}

interface CellGroup { coverage: number; outline: number; edge: number; r: number; g: number; b: number; alpha: number }

function cellRange(index: number, sourceLength: number, targetLength: number, boundaries?: readonly number[]) {
  const useBoundaries = boundaries?.length === targetLength + 1;
  const start = useBoundaries ? clamp(boundaries[index], 0, sourceLength) : index * sourceLength / targetLength;
  const end = useBoundaries ? clamp(boundaries[index + 1], start, sourceLength) : (index + 1) * sourceLength / targetLength;
  return { start, end, first: Math.floor(start), last: Math.ceil(end) };
}

export function edgeAwareDownscale(
  source: ImageData,
  targetWidth: number,
  targetHeight: number,
  boundaries: { x?: readonly number[]; y?: readonly number[] } = {},
) {
  const width = Math.max(1, Math.round(targetWidth)); const height = Math.max(1, Math.round(targetHeight));
  const output = makeImageData(width, height);
  const prepared = prepareEdges(source);
  const coverage = new Float32Array(width * height); const occupancy = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const yr = cellRange(y, source.height, height, boundaries.y);
    for (let x = 0; x < width; x++) {
      const xr = cellRange(x, source.width, width, boundaries.x);
      let alphaArea = 0; let featureArea = 0; let area = 0;
      for (let sy = yr.first; sy < yr.last; sy++) for (let sx = xr.first; sx < xr.last; sx++) {
        const overlap = Math.max(0, Math.min(sx + 1, xr.end) - Math.max(sx, xr.start)) * Math.max(0, Math.min(sy + 1, yr.end) - Math.max(sy, yr.start));
        if (!overlap || sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
        const sourceIndex = sy * source.width + sx;
        alphaArea += overlap * source.data[sourceIndex * 4 + 3] / 255;
        featureArea += overlap * Math.max(prepared.outline[sourceIndex], prepared.edge[sourceIndex]);
        area += overlap;
      }
      const index = y * width + x;
      coverage[index] = alphaArea / Math.max(area, 1e-9);
      const centerX = clamp(Math.floor((xr.start + xr.end) / 2), 0, source.width - 1);
      const centerY = clamp(Math.floor((yr.start + yr.end) / 2), 0, source.height - 1);
      occupancy[index] = coverage[index] >= 0.5 || (coverage[index] >= 0.125 && (prepared.opaque[centerY * source.width + centerX] || featureArea / Math.max(area, 1e-9) >= 0.08)) ? 1 : 0;
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!occupancy[index]) continue;
    const boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1 || !occupancy[index - 1] || !occupancy[index + 1] || !occupancy[index - width] || !occupancy[index + width];
    const xr = cellRange(x, source.width, width, boundaries.x); const yr = cellRange(y, source.height, height, boundaries.y);
    const centerX = clamp(Math.floor((xr.start + xr.end) / 2), 0, source.width - 1);
    const centerY = clamp(Math.floor((yr.start + yr.end) / 2), 0, source.height - 1);
    const centerOffset = (centerY * source.width + centerX) * 4;
    const centerKey = source.data[centerOffset + 3] > 16
      ? ((source.data[centerOffset] >> 3) << 10) | ((source.data[centerOffset + 1] >> 3) << 5) | (source.data[centerOffset + 2] >> 3)
      : -1;
    if (!boundary && centerKey >= 0) {
      const targetOffset = index * 4;
      output.data[targetOffset] = source.data[centerOffset];
      output.data[targetOffset + 1] = source.data[centerOffset + 1];
      output.data[targetOffset + 2] = source.data[centerOffset + 2];
      output.data[targetOffset + 3] = prepared.binaryAlpha ? 255 : clampByte(coverage[index] * 255);
      continue;
    }
    const groups = new Map<number, CellGroup>(); let area = 0; let outlineArea = 0;
    for (let sy = yr.first; sy < yr.last; sy++) for (let sx = xr.first; sx < xr.last; sx++) {
      const overlap = Math.max(0, Math.min(sx + 1, xr.end) - Math.max(sx, xr.start)) * Math.max(0, Math.min(sy + 1, yr.end) - Math.max(sy, yr.start));
      if (!overlap || sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const sourceIndex = sy * source.width + sx; const offset = sourceIndex * 4;
      const alpha = source.data[offset + 3] / 255; const effective = overlap * alpha;
      if (effective <= 0) continue;
      const key = ((source.data[offset] >> 3) << 10) | ((source.data[offset + 1] >> 3) << 5) | (source.data[offset + 2] >> 3);
      const group = groups.get(key) || { coverage: 0, outline: 0, edge: 0, r: 0, g: 0, b: 0, alpha: 0 };
      group.coverage += effective; group.outline += effective * prepared.outline[sourceIndex]; group.edge += effective * prepared.edge[sourceIndex];
      group.r += source.data[offset] * effective; group.g += source.data[offset + 1] * effective; group.b += source.data[offset + 2] * effective; group.alpha += source.data[offset + 3] * overlap;
      groups.set(key, group); area += overlap; outlineArea += effective * prepared.outline[sourceIndex];
    }
    let winner: CellGroup | undefined; let winnerScore = -Infinity;
    const restrictOutline = boundary && outlineArea / Math.max(area, 1e-9) >= 0.02;
    for (const [key, group] of groups) {
      if (restrictOutline && group.outline <= 0) continue;
      // PixelOE keeps the center sample unless local contrast provides strong
      // evidence for a thin feature. The center bonus prevents area voting
      // from moving eyes and highlights, while edge/outline evidence can still
      // rescue details that nearest-neighbor misses entirely.
      const centerBonus = key === centerKey ? area * 0.34 : 0;
      const score = group.coverage + centerBonus + 0.85 * group.edge + (boundary ? 1.05 : 0.25) * group.outline;
      if (score > winnerScore) { winner = group; winnerScore = score; }
    }
    if (!winner) continue;
    const divisor = Math.max(winner.coverage, 1e-9); const offset = index * 4;
    output.data[offset] = clampByte(winner.r / divisor); output.data[offset + 1] = clampByte(winner.g / divisor); output.data[offset + 2] = clampByte(winner.b / divisor);
    output.data[offset + 3] = prepared.binaryAlpha ? 255 : clampByte(coverage[index] * 255);
  }
  return output;
}

function nearestResize(source: ImageData, targetWidth: number, targetHeight: number) {
  const output = makeImageData(targetWidth, targetHeight);
  for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
    const sx = clamp(Math.floor((x + 0.5) * source.width / targetWidth), 0, source.width - 1);
    const sy = clamp(Math.floor((y + 0.5) * source.height / targetHeight), 0, source.height - 1);
    const sourceOffset = (sy * source.width + sx) * 4; const targetOffset = (y * targetWidth + x) * 4;
    output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
  }
  return output;
}

function applyPerfectPixelSquareAdjustment(source: ImageData, adjustment?: PixelGridDetection["squareAdjustment"]) {
  if (!adjustment) return source;
  const removeColumn = adjustment === "remove-column"; const removeRow = adjustment === "remove-row";
  const addColumn = adjustment === "add-column"; const addRow = adjustment === "add-row";
  const width = source.width + (addColumn ? 1 : removeColumn ? -1 : 0);
  const height = source.height + (addRow ? 1 : removeRow ? -1 : 0);
  const output = makeImageData(Math.max(1, width), Math.max(1, height));
  for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
    const sourceX = addColumn ? Math.max(0, x - 1) : x;
    const sourceY = addRow ? Math.max(0, y - 1) : y;
    const sourceOffset = (sourceY * source.width + sourceX) * 4;
    const targetOffset = (y * output.width + x) * 4;
    output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
  }
  return output;
}

function pasteCentered(source: ImageData, width: number, height: number) {
  const output = makeImageData(width, height);
  const left = Math.floor((width - source.width) / 2); const top = Math.floor((height - source.height) / 2);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const targetOffset = ((top + y) * width + left + x) * 4; const sourceOffset = (y * source.width + x) * 4;
    output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
  }
  return output;
}

interface ContentBounds { left: number; top: number; right: number; bottom: number }

function sharedContentBounds(frames: ImageData[]): ContentBounds {
  const width = frames[0]?.width ?? 1; const height = frames[0]?.height ?? 1;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (const frame of frames) for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    if (frame.data[(y * frame.width + x) * 4 + 3] <= 16) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) return { left: 0, top: 0, right: width, bottom: height };
  const marginX = Math.max(2, Math.ceil((maxX - minX + 1) * 0.01));
  const marginY = Math.max(2, Math.ceil((maxY - minY + 1) * 0.01));
  return {
    left: Math.max(0, minX - marginX), top: Math.max(0, minY - marginY),
    right: Math.min(width, maxX + 1 + marginX), bottom: Math.min(height, maxY + 1 + marginY),
  };
}

function cropPixelArt(source: ImageData, bounds: ContentBounds) {
  const width = Math.max(1, bounds.right - bounds.left); const height = Math.max(1, bounds.bottom - bounds.top);
  if (bounds.left === 0 && bounds.top === 0 && width === source.width && height === source.height) return source;
  const output = makeImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceOffset = ((bounds.top + y) * source.width + bounds.left + x) * 4;
    output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4);
  }
  return output;
}

function fitPixelArt(source: ImageData, width: number, height: number) {
  // A smaller recovered sprite should remain at its native pixel scale. Only
  // reduce it when its content crop cannot fit inside the requested canvas.
  const scale = Math.min(1, width / source.width, height / source.height);
  const drawWidth = Math.max(1, Math.round(source.width * scale)); const drawHeight = Math.max(1, Math.round(source.height * scale));
  const resized = drawWidth < source.width || drawHeight < source.height
    ? edgeAwareDownscale(source, drawWidth, drawHeight)
    : source;
  return pasteCentered(resized, width, height);
}

function recoverPixelArtSource(source: ImageData, grid: PixelGridDetection, recoverGrid: boolean, targetWidth: number, targetHeight: number) {
  // A weak FFT proposal can satisfy the geometric cell-size checks while
  // actually locking onto character features instead of the source lattice.
  // Keep the proposal available for diagnostics, but do not let it rewrite
  // facial features or other small details. A validated Sobel fallback has no
  // comparable FFT score, so it remains eligible for recovery.
  const trustworthyGrid = grid.gradientFallbackUsed || grid.confidence >= 0.1;
  const alignedColumns = grid.alignedColumns ?? (grid.xBoundaries?.length ? Math.max(1, grid.xBoundaries.length - 1) : grid.columns);
  const alignedRows = grid.alignedRows ?? (grid.yBoundaries?.length ? Math.max(1, grid.yBoundaries.length - 1) : grid.rows);
  // When the detected native grid is finer than the requested output, grid
  // recovery would create an unnecessary intermediate and then resample it a
  // second time. Downscale the original source directly so eyes and other
  // one-pixel features are sampled only once.
  const targetCanRepresentGrid = alignedColumns <= targetWidth && alignedRows <= targetHeight;
  if (!recoverGrid || !grid.detected || !trustworthyGrid || !targetCanRepresentGrid) return { imageData: source, gridRecovered: false };
  const recovered = edgeAwareDownscale(source, alignedColumns, alignedRows, { x: grid.xBoundaries, y: grid.yBoundaries });
  return { imageData: applyPerfectPixelSquareAdjustment(recovered, grid.squareAdjustment), gridRecovered: true };
}

export function pixelateImageData(source: ImageData, width: number, height: number, paletteSize = 24, options: PixelArtProcessOptions = {}): PixelArtProcessResult {
  const recoverGrid = options.recoverGrid !== false;
  const grid = options.gridHint || detectPseudoPixelGrid(source);
  const outputWidth = Math.max(1, Math.round(width)); const outputHeight = Math.max(1, Math.round(height));
  const recovered = recoverPixelArtSource(source, grid, recoverGrid, outputWidth, outputHeight);
  const cropped = cropPixelArt(recovered.imageData, sharedContentBounds([recovered.imageData]));
  let imageData = fitPixelArt(cropped, outputWidth, outputHeight);
  const palette = options.quantize === false ? [] : derivePerceptualPalette([imageData], paletteSize);
  if (palette.length) imageData = applyPerceptualPalette(imageData, palette);
  return { imageData, grid, gridRecovered: recovered.gridRecovered, palette };
}

interface WeightedCellColor { r: number; g: number; b: number; weight: number }

function robustCellColor(source: ImageData, firstX: number, lastX: number, firstY: number, lastY: number) {
  const colors: WeightedCellColor[] = []; let opaqueWeight = 0; let transparentWeight = 0;
  for (let sourceY = firstY; sourceY < Math.min(source.height, lastY); sourceY++) for (let sourceX = firstX; sourceX < Math.min(source.width, lastX); sourceX++) {
    const offset = (sourceY * source.width + sourceX) * 4; const weight = source.data[offset + 3] / 255;
    transparentWeight += 1 - weight;
    if (weight > 0) {
      colors.push({ r: source.data[offset], g: source.data[offset + 1], b: source.data[offset + 2], weight });
      opaqueWeight += weight;
    }
  }
  if (!colors.length || transparentWeight >= opaqueWeight) return undefined;

  let meanR = 0; let meanG = 0; let meanB = 0;
  for (const color of colors) { meanR += color.r * color.weight; meanG += color.g * color.weight; meanB += color.b * color.weight; }
  meanR /= opaqueWeight; meanG /= opaqueWeight; meanB /= opaqueWeight;
  let variance = 0;
  for (const color of colors) variance += color.weight * ((color.r - meanR) ** 2 + (color.g - meanG) ** 2 + (color.b - meanB) ** 2);
  variance /= opaqueWeight;

  // PerfectPixel's median sampler is robust to compression noise in flat
  // interior cells, where clustering would manufacture unstable shade splits.
  if (variance < 220) {
    const weightedMedian = (channel: "r" | "g" | "b") => {
      const ordered = [...colors].sort((a, b) => a[channel] - b[channel]); let accumulated = 0;
      for (const color of ordered) { accumulated += color.weight; if (accumulated >= opaqueWeight / 2) return color[channel]; }
      return ordered[ordered.length - 1][channel];
    };
    return [weightedMedian("r"), weightedMedian("g"), weightedMedian("b")] as RGB;
  }

  // PerfectPixel-style two-cluster majority sampling. Cluster raw cell colors
  // before palette mapping so codec variants of one shade vote together.
  let first = colors[0];
  for (const color of colors) if ((color.r - first.r) ** 2 + (color.g - first.g) ** 2 + (color.b - first.b) ** 2 > 0) { first = color; break; }
  let c0 = first; let farthest = -1;
  for (const color of colors) {
    const distance = (color.r - first.r) ** 2 + (color.g - first.g) ** 2 + (color.b - first.b) ** 2;
    if (distance > farthest) { farthest = distance; c0 = color; }
  }
  let c1 = c0; farthest = -1;
  for (const color of colors) {
    const distance = (color.r - c0.r) ** 2 + (color.g - c0.g) ** 2 + (color.b - c0.b) ** 2;
    if (distance > farthest) { farthest = distance; c1 = color; }
  }
  let center0: RGB = [c0.r, c0.g, c0.b]; let center1: RGB = [c1.r, c1.g, c1.b]; let weight0 = 0; let weight1 = 0;
  for (let iteration = 0; iteration < 4; iteration++) {
    let r0 = 0; let g0 = 0; let b0 = 0; let r1 = 0; let g1 = 0; let b1 = 0; weight0 = 0; weight1 = 0;
    for (const color of colors) {
      const distance0 = (color.r - center0[0]) ** 2 + (color.g - center0[1]) ** 2 + (color.b - center0[2]) ** 2;
      const distance1 = (color.r - center1[0]) ** 2 + (color.g - center1[1]) ** 2 + (color.b - center1[2]) ** 2;
      if (distance1 < distance0) { r1 += color.r * color.weight; g1 += color.g * color.weight; b1 += color.b * color.weight; weight1 += color.weight; }
      else { r0 += color.r * color.weight; g0 += color.g * color.weight; b0 += color.b * color.weight; weight0 += color.weight; }
    }
    if (weight0 > 0) center0 = [r0 / weight0, g0 / weight0, b0 / weight0];
    if (weight1 > 0) center1 = [r1 / weight1, g1 / weight1, b1 / weight1];
  }
  return weight1 > weight0 ? center1 : center0;
}

function reconstructFrameAtBaseGrid(source: ImageData, width: number, height: number, palette: RGB[], previous?: ImageData) {
  const targetWidth = Math.max(1, Math.round(width)); const targetHeight = Math.max(1, Math.round(height));
  const output = makeImageData(targetWidth, targetHeight);
  const colorCache = new Map<number, number>();
  const nearestPaletteIndex = (r: number, g: number, b: number) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cached = colorCache.get(key);
    if (cached !== undefined) return cached;
    // Measure from the deterministic center of the 5-bit cache bucket. Using
    // the first encountered source color makes the mapping traversal- and
    // frame-dependent even when every frame shares the same palette.
    const bucketR = (((key >> 10) & 31) << 3) + 4;
    const bucketG = (((key >> 5) & 31) << 3) + 4;
    const bucketB = ((key & 31) << 3) + 4;
    let best = 0; let bestDistance = Infinity;
    for (let index = 0; index < palette.length; index++) {
      const color = palette[index];
      const distance = (bucketR - color[0]) ** 2 + (bucketG - color[1]) ** 2 + (bucketB - color[2]) ** 2;
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    }
    colorCache.set(key, best);
    return best;
  };
  for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
    const firstX = Math.floor(x * source.width / targetWidth); const lastX = Math.max(firstX + 1, Math.floor((x + 1) * source.width / targetWidth));
    const firstY = Math.floor(y * source.height / targetHeight); const lastY = Math.max(firstY + 1, Math.floor((y + 1) * source.height / targetHeight));
    const sample = robustCellColor(source, firstX, lastX, firstY, lastY);
    const target = (y * targetWidth + x) * 4;
    if (!sample) continue;
    let winner = nearestPaletteIndex(sample[0], sample[1], sample[2]);
    if (previous?.data[target + 3]) {
      const previousColor: RGB = [previous.data[target], previous.data[target + 1], previous.data[target + 2]];
      const previousIndex = palette.findIndex((color) => color[0] === previousColor[0] && color[1] === previousColor[1] && color[2] === previousColor[2]);
      if (previousIndex >= 0 && previousIndex !== winner) {
        const currentColor = palette[winner];
        const currentDistance = (sample[0] - currentColor[0]) ** 2 + (sample[1] - currentColor[1]) ** 2 + (sample[2] - currentColor[2]) ** 2;
        const previousDistance = (sample[0] - previousColor[0]) ** 2 + (sample[1] - previousColor[1]) ** 2 + (sample[2] - previousColor[2]) ** 2;
        const paletteDistance = (currentColor[0] - previousColor[0]) ** 2 + (currentColor[1] - previousColor[1]) ** 2 + (currentColor[2] - previousColor[2]) ** 2;
        // Keep the prior palette entry only for an ambiguous choice between
        // nearby shades. Decisive color changes and silhouette motion pass
        // through, avoiding trails while suppressing codec-driven flicker.
        if (paletteDistance <= 34 ** 2 && previousDistance <= currentDistance + 180) winner = previousIndex;
      }
    }
    output.data[target] = palette[winner][0]; output.data[target + 1] = palette[winner][1]; output.data[target + 2] = palette[winner][2]; output.data[target + 3] = 255;
  }
  return output;
}

/**
 * Fixed-resolution animation snapper. Every selected output pixel is
 * independently reconstructed with robust full-frame cells and one shared
 * palette. This intentionally bypasses FFT/Sobel grid detection for video.
 */
export function pixelateAnimationFrames(frames: ImageData[], width: number, height: number, paletteSize = 24) {
  if (!frames.length) return { frames: [] as ImageData[], palette: [] as RGB[] };
  const palette = derivePerceptualPalette(frames, paletteSize);
  const outputWidth = Math.max(1, Math.round(width)); const outputHeight = Math.max(1, Math.round(height));
  const reconstructed: ImageData[] = [];
  for (const frame of frames) reconstructed.push(reconstructFrameAtBaseGrid(frame, outputWidth, outputHeight, palette, reconstructed[reconstructed.length - 1]));
  return { frames: reconstructed, palette };
}

export function naiveResizeImageData(source: ImageData, width: number, height: number) {
  const cropped = cropPixelArt(source, sharedContentBounds([source]));
  const scale = Math.min(width / cropped.width, height / cropped.height);
  const drawWidth = Math.max(1, Math.round(cropped.width * scale)); const drawHeight = Math.max(1, Math.round(cropped.height * scale));
  return pasteCentered(nearestResize(cropped, drawWidth, drawHeight), width, height);
}
