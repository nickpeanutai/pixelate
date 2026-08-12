export type OriginalFrameFitting = "contain" | "crop" | "stretch";

export interface FrameDrawTransform {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export function originalFrameDrawTransform(
  sourceWidth: number,
  sourceHeight: number,
  targetSize: number,
  fitting: OriginalFrameFitting,
): FrameDrawTransform {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetSize <= 0) throw new Error("Frame dimensions must be positive");

  if (fitting === "stretch") {
    return { sourceX: 0, sourceY: 0, sourceWidth, sourceHeight, outputWidth: targetSize, outputHeight: targetSize };
  }

  if (fitting === "crop") {
    const side = Math.min(sourceWidth, sourceHeight);
    return {
      sourceX: (sourceWidth - side) / 2,
      sourceY: (sourceHeight - side) / 2,
      sourceWidth: side,
      sourceHeight: side,
      outputWidth: targetSize,
      outputHeight: targetSize,
    };
  }

  const scale = targetSize / Math.max(sourceWidth, sourceHeight);
  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth,
    sourceHeight,
    outputWidth: Math.max(1, Math.round(sourceWidth * scale)),
    outputHeight: Math.max(1, Math.round(sourceHeight * scale)),
  };
}
