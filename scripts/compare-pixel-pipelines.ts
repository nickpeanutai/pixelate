import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  pixelateImageData,
  removeChromaBackground,
  type PixelGridDetection,
} from "../packages/pixel-core/src/index";

class NodeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data; this.width = width; this.height = height;
  }
}

// The production implementation uses the browser ImageData object. This
// equivalent makes the deterministic comparison runnable from the repository.
// @ts-expect-error Node comparison polyfill
globalThis.ImageData = NodeImageData;

function readPng(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return new ImageData(new Uint8ClampedArray(png.data), png.width, png.height);
}

function writePng(path: string, image: ImageData) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  writeFileSync(path, PNG.sync.write(png));
}

function preview(image: ImageData, scale: number) {
  const width = image.width * scale; const height = image.height * scale;
  const output = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = Math.floor(x / scale); const sourceY = Math.floor(y / scale);
    const sourceOffset = (sourceY * image.width + sourceX) * 4;
    const targetOffset = (y * width + x) * 4;
    const checker = ((Math.floor(x / 16) + Math.floor(y / 16)) & 1) ? 31 : 24;
    const alpha = image.data[sourceOffset + 3] / 255;
    output.data[targetOffset] = Math.round(image.data[sourceOffset] * alpha + checker * (1 - alpha));
    output.data[targetOffset + 1] = Math.round(image.data[sourceOffset + 1] * alpha + (checker + 4) * (1 - alpha));
    output.data[targetOffset + 2] = Math.round(image.data[sourceOffset + 2] * alpha + (checker + 10) * (1 - alpha));
    output.data[targetOffset + 3] = 255;
  }
  return output;
}

function originalPreview(image: ImageData, size: number) {
  const output = new ImageData(new Uint8ClampedArray(size * size * 4), size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / size));
    const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / size));
    const sourceOffset = (sourceY * image.width + sourceX) * 4;
    output.data.set(image.data.subarray(sourceOffset, sourceOffset + 4), (y * size + x) * 4);
  }
  return output;
}

function contactSheet(left: ImageData, right: ImageData) {
  const gap = 24; const bar = 14;
  const output = new ImageData(new Uint8ClampedArray((left.width * 2 + gap) * (left.height + bar) * 4), left.width * 2 + gap, left.height + bar);
  for (let offset = 0; offset < output.data.length; offset += 4) output.data.set([12, 17, 26, 255], offset);
  const paste = (source: ImageData, leftOffset: number) => {
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const sourceOffset = (y * source.width + x) * 4;
      const targetOffset = ((y + bar) * output.width + leftOffset + x) * 4;
      output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  };
  // Coral = exact original source, teal = Pixelate extraction.
  for (let y = 0; y < bar; y++) {
    for (let x = 0; x < left.width; x++) output.data.set([209, 77, 100, 255], (y * output.width + x) * 4);
    for (let x = left.width + gap; x < output.width; x++) output.data.set([78, 215, 201, 255], (y * output.width + x) * 4);
  }
  paste(left, 0); paste(right, left.width + gap);
  return output;
}

function describeGrid(grid: PixelGridDetection, recovered: boolean) {
  return grid.detected
    ? `${grid.columns}x${grid.rows} grid candidate, ${Math.round(grid.confidence * 100)}% confidence, ${recovered ? "recovered" : "skipped"}`
    : `no safe grid recovery (${Math.round(grid.confidence * 100)}% confidence; candidate ${grid.stepX.toFixed(2)}×${grid.stepY.toFixed(2)}px)`;
}

function prepareSource(source: ImageData) {
  const samples: Array<[number, number, number, number]> = [];
  const add = (x: number, y: number) => {
    const offset = (y * source.width + x) * 4;
    samples.push([source.data[offset], source.data[offset + 1], source.data[offset + 2], source.data[offset + 3]]);
  };
  const strideX = Math.max(1, Math.floor(source.width / 32));
  const strideY = Math.max(1, Math.floor(source.height / 32));
  for (let x = 0; x < source.width; x += strideX) { add(x, 0); add(x, source.height - 1); }
  for (let y = 0; y < source.height; y += strideY) { add(0, y); add(source.width - 1, y); }
  if (samples.filter((sample) => sample[3] < 32).length / Math.max(1, samples.length) > 0.8) {
    return { image: source, background: "already transparent" };
  }
  const average = samples.reduce((sum, sample) => [sum[0] + sample[0], sum[1] + sample[1], sum[2] + sample[2]], [0, 0, 0])
    .map((value) => value / Math.max(1, samples.length));
  const magentaDistance = Math.hypot(average[0] - 255, average[1], average[2] - 255);
  const greenDistance = Math.hypot(average[0], average[1] - 255, average[2]);
  const key = magentaDistance <= greenDistance ? "magenta" : "green";
  if (Math.min(magentaDistance, greenDistance) > 100) return { image: source, background: "kept opaque" };
  const matte = removeChromaBackground(source, key);
  return matte.stats.success
    ? { image: matte.imageData, background: `${key} chroma removed` }
    : { image: source, background: `${key} chroma removal rejected: ${matte.stats.reason}` };
}

const root = resolve(import.meta.dirname, "..");
const inputPath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "public/assets/demo-alchemist.png");
const outputDir = resolve(root, "docs/comparisons/pixel-pipeline");
mkdirSync(outputDir, { recursive: true });
const decoded = readPng(inputPath);
const prepared = prepareSource(decoded);
const input = prepared.image;
console.log(`Input preprocessing: ${prepared.background}`);

for (const target of [64, 128, 256]) {
  const optimized = pixelateImageData(input, target, target, 24);
  const optimizedUnquantized = pixelateImageData(input, target, target, 24, { quantize: false });
  writePng(resolve(outputDir, `optimized-unquantized-${target}.png`), optimizedUnquantized.imageData);
  writePng(resolve(outputDir, `optimized-${target}.png`), optimized.imageData);
  const scale = Math.max(1, Math.floor(512 / target));
  writePng(resolve(outputDir, `comparison-${target}.png`), contactSheet(originalPreview(decoded, 512), preview(optimized.imageData, scale)));
  console.log(`${target}x${target}: ${describeGrid(optimized.grid, optimized.gridRecovered)}; shared ${optimized.palette.length}-color palette`);
}
