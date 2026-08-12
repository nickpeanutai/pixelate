import type { ProjectFrame } from "@pixel-sprite/project-schema";

export type EditableExtractedFrame = {
  frame: ProjectFrame;
  imageData: ImageData;
  timeMs: number;
};

export function deleteExtractedFrame(frames: EditableExtractedFrame[], index: number) {
  if (frames.length <= 1 || !frames[index]) return frames;
  return frames.filter((_, frameIndex) => frameIndex !== index);
}

export function duplicateExtractedFrame(frames: EditableExtractedFrame[], index: number, id: string) {
  const source = frames[index];
  if (!source) return frames;
  const copy: EditableExtractedFrame = {
    ...source,
    frame: { ...source.frame, id, name: `${source.frame.name} copy` },
    imageData: new ImageData(new Uint8ClampedArray(source.imageData.data), source.imageData.width, source.imageData.height),
  };
  return [...frames.slice(0, index + 1), copy, ...frames.slice(index + 1)];
}

export function mirrorExtractedFrame(frames: EditableExtractedFrame[], index: number) {
  if (!frames[index]) return frames;
  return frames.map((item, frameIndex) => frameIndex === index
    ? { ...item, frame: { ...item.frame, mirrored: !item.frame.mirrored } }
    : item);
}
