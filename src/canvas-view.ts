export const zoomLevels = [0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const minZoom = zoomLevels[0];
export const maxZoom = zoomLevels[zoomLevels.length - 1];

export function zoomOut(value: number) {
  return [...zoomLevels].reverse().find((level) => level < value - 0.001) ?? minZoom;
}

export function zoomIn(value: number) {
  return zoomLevels.find((level) => level > value + 0.001) ?? maxZoom;
}

export function fitCanvasZoom(width: number, height: number, availableWidth: number, availableHeight: number, padding = 68) {
  if (width <= 0 || height <= 0 || availableWidth <= 0 || availableHeight <= 0) return 1;
  const horizontal = Math.max(1, availableWidth - padding) / width;
  const vertical = Math.max(1, availableHeight - padding) / height;
  return Math.min(maxZoom, Math.max(0.01, Math.min(horizontal, vertical)));
}

export function canvasDisplaySize(width: number, height: number, zoom: number) {
  const safeZoom = Math.min(maxZoom, Math.max(0.01, zoom));
  return { width: width * safeZoom, height: height * safeZoom };
}
