import {
  DEFAULT_IMAGE_TEMPLATE_ID,
  DEFAULT_PROMPT_IMAGE_SIZE,
  DEFAULT_VIDEO_TEMPLATE_ID,
  type BackgroundMode,
  type ChromaKeyName,
  type PromptImageSize,
} from "@pixel-sprite/project-schema";

export type PromptTemplateKind = "image" | "video";

export interface PromptTemplateDefinition {
  id: string;
  kind: PromptTemplateKind;
  name: string;
  description: string;
  inputLabel: string;
  inputPlaceholder: string;
  build(input: {
    userText: string;
    backgroundMode: BackgroundMode;
    chromaKey: ChromaKeyName;
    imageSize: PromptImageSize;
  }): string;
}

const chromaConflictPattern = /\b(pink|purple|magenta|fuchsia|rose|violet)\b|粉色?|紫色?|洋红|品红/i;

export function resolveChromaKey(text: string, selected: ChromaKeyName = "magenta"): ChromaKeyName {
  return selected === "magenta" && chromaConflictPattern.test(text) ? "green" : selected;
}

export function buildChromaPrompt(prompt: string, key: ChromaKeyName) {
  const color = key === "green" ? "#00FF00 (RGB 0,255,0) chroma green" : "#FF00FF (RGB 255,0,255) chroma magenta";
  return `${prompt.trim()}\n\nBACKGROUND EXTRACTION CONTRACT:\n- Fill the entire background edge to edge with one perfectly uniform flat ${color}.\n- Do not use that key color anywhere on the subject, including clothing, props, outlines, highlights, glow, or effects.\n- No gradient, texture, scenery, floor, shadow, lighting falloff, frame, border, text, or background objects.\n- Keep one complete subject centered with generous empty key-color margin on every side; nothing may touch or be cropped by the image edge.`;
}

export function buildVideoChromaPrompt(prompt: string, key: ChromaKeyName) {
  const color = key === "green" ? "#00FF00 (RGB 0,255,0)" : "#FF00FF (RGB 255,0,255)";
  return `${buildChromaPrompt(prompt, key)}\n\nVIDEO CHROMA LOCK:\n- Preserve the exact ${color} key background unchanged in every frame.\n- Animate only the subject. Lock the camera, canvas, framing, scale, and background.\n- No camera movement, cuts, shadows, blur, trails, particles, scenery, or lighting changes.\n- Keep the subject complete and separated from all image borders.`;
}

const imageTemplate: PromptTemplateDefinition = {
  id: DEFAULT_IMAGE_TEMPLATE_ID,
  kind: "image",
  name: "Animation-ready character",
  description: "Creates a clean character source suitable for pixel processing and image-to-video animation.",
  inputLabel: "Describe the subject",
  inputPlaceholder: "Describe the character or object, its appearance, clothing, colors, and important props. Chinese or English is supported.",
  build: ({ userText, backgroundMode, chromaKey, imageSize }) => {
    const base = [
      userText.trim(),
      `Create one square animation-ready source image that visually simulates native ${imageSize}×${imageSize} pixel art.`,
      "Show exactly one complete subject in a clear neutral starting pose, centered at a stable scale with generous empty margin on all four sides.",
      "Keep the full silhouette, head, hands, feet, clothing and props completely visible and separated from every image edge.",
      "Use crisp pixel-art shapes, controlled colors, readable hard edges and consistent front-facing game-sprite proportions.",
      "Do not add transparency, cropping, shadows, a floor, gradients, glow, particles, text, UI, scenery, duplicate subjects or background objects.",
    ].join("\n");
    return backgroundMode === "transparent" ? buildChromaPrompt(base, chromaKey) : base;
  },
};

const videoTemplate: PromptTemplateDefinition = {
  id: DEFAULT_VIDEO_TEMPLATE_ID,
  kind: "video",
  name: "Seamless in-place loop",
  description: "Keeps the camera and chroma background fixed while animating only the reference subject.",
  inputLabel: "Describe the action",
  inputPlaceholder: "Describe the motion, for example: walk in place with a confident heavy stride.",
  build: ({ userText, backgroundMode, chromaKey }) => {
    const base = [
      userText.trim(),
      "Use the supplied source image as the exact first frame and animate only its subject performing the action described above.",
      "Create a seamless in-place loop with a fixed camera, fixed canvas, stable scale, stable framing and consistent subject design.",
      "Keep the complete subject visible with clear empty margin from every edge in every frame.",
      "Do not add cuts, zoom, camera movement, background changes, shadows, a floor, motion blur, trails, particles, lighting changes, text or extra subjects.",
    ].join("\n");
    return backgroundMode === "transparent" ? buildVideoChromaPrompt(base, chromaKey) : base;
  },
};

export const promptTemplates: readonly PromptTemplateDefinition[] = [imageTemplate, videoTemplate];

export function getPromptTemplates(kind: PromptTemplateKind) {
  return promptTemplates.filter((template) => template.kind === kind);
}

export function getPromptTemplate(kind: PromptTemplateKind, templateId: string) {
  const templates = getPromptTemplates(kind);
  return templates.find((template) => template.id === templateId) ?? templates[0];
}

export function generatePrompt(templateId: string, input: {
  kind: PromptTemplateKind;
  userText: string;
  backgroundMode: BackgroundMode;
  chromaKey: ChromaKeyName;
  imageSize?: PromptImageSize;
}) {
  const template = getPromptTemplate(input.kind, templateId);
  if (!template) throw new Error(`No ${input.kind} prompt template is available.`);
  const userText = input.userText.trim();
  if (!userText) throw new Error(template.inputLabel === "Describe the action" ? "Describe the action first." : "Describe the subject first.");
  const chromaKey = input.backgroundMode === "transparent" ? resolveChromaKey(userText, input.chromaKey) : input.chromaKey;
  return {
    prompt: template.build({
      userText,
      backgroundMode: input.backgroundMode,
      chromaKey,
      imageSize: input.imageSize ?? DEFAULT_PROMPT_IMAGE_SIZE,
    }),
    chromaKey,
    template,
  };
}
