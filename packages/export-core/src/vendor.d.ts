declare module "gifenc" {
  export function GIFEncoder(options?: Record<string, unknown>): { writeFrame(index: Uint8Array, width: number, height: number, options?: Record<string, unknown>): void; finish(): void; bytes(): Uint8Array };
  export function quantize(data: Uint8ClampedArray, maxColors: number, options?: Record<string, unknown>): number[][];
  export function applyPalette(data: Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}
declare module "upng-js" {
  const UPNG: { encode(buffers: ArrayBuffer[], width: number, height: number, colors: number, delays?: number[]): ArrayBuffer };
  export default UPNG;
}
