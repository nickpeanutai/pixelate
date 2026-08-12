import fs from "node:fs";
import { PNG } from "pngjs";
import { detectPseudoPixelGrid } from "../packages/pixel-core/src/pixel-art";

class NodeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

Object.assign(globalThis, { ImageData: NodeImageData });

const path = process.argv[2];
if (!path) throw new Error("Usage: pnpm vite-node scripts/inspect-pixel-grid.ts <png>");
const png = PNG.sync.read(fs.readFileSync(path));
const source = new ImageData(new Uint8ClampedArray(png.data), png.width, png.height);
const started = performance.now();
const result = detectPseudoPixelGrid(source);
console.log(JSON.stringify({ ...result, xBoundaries: result.xBoundaries?.length, yBoundaries: result.yBoundaries?.length, milliseconds: Math.round(performance.now() - started) }, null, 2));
