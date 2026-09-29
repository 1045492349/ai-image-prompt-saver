// Shared metadata model embedded into downloaded images.
// Flattened to Record<string,string> before writing into image containers.

export interface GenerationMeta {
  prompt: string;
  negativePrompt?: string;
  model: string;
  source: string; // host that produced the image, e.g. "wenxin-assistant"
  imageUrl: string;
  imageType?: string; // "JPEG" | "PNG"
  width?: number;
  height?: number;
  seed?: string;
  createdAt: string; // ISO-8601
  tool: string; // extension name
  toolVersion: string;
}

export type MetaEntries = Record<string, string>;

// Flatten GenerationMeta into ASCII-keyed string entries shared by PNG/JPEG.
export function metaToEntries(meta: GenerationMeta): MetaEntries {
  const entries: MetaEntries = {
    AIP_PROMPT: meta.prompt ?? "",
    AIP_MODEL: meta.model ?? "",
    AIP_SOURCE: meta.source ?? "",
    AIP_CREATED_AT: meta.createdAt ?? "",
    AIP_TOOL: meta.tool ?? "",
    AIP_TOOL_VERSION: meta.toolVersion ?? "",
    AIP_IMAGE_URL: meta.imageUrl ?? "",
  };
  if (meta.negativePrompt) entries.AIP_NEGATIVE_PROMPT = meta.negativePrompt;
  if (meta.imageType) entries.AIP_IMAGE_TYPE = meta.imageType;
  if (meta.width != null) entries.AIP_WIDTH = String(meta.width);
  if (meta.height != null) entries.AIP_HEIGHT = String(meta.height);
  if (meta.seed) entries.AIP_SEED = meta.seed;
  return entries;
}
