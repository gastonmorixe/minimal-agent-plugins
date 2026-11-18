/**
 * Snapshot of `modalities.input` per model from the live catalog
 * (https://opencode.ai/zen/go/v1/models, 2026-11-17, 32 models). Each list names the input
 * types that the gateway takes for the model. Update it from the live
 * catalog when the gateway adds a model.
 *
 * @module llm/providers/opencode-go/live-input
 */

const L0: readonly string[] = ["text"]
const L1: readonly string[] = [
  "text",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]
const L2: readonly string[] = ["text", "image/jpeg", "image/png", "image/gif", "image/webp"]
const L3: readonly string[] = [
  "text",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/mpeg",
  "audio/m4a",
  "audio/l16",
  "audio/opus",
  "audio/alaw",
  "audio/mulaw",
  "audio/webm",
  "application/pdf",
]
const L4: readonly string[] = [
  "text",
  "image/jpeg",
  "image/png",
  "video/mp4",
  "video/x-matroska",
  "video/quicktime",
]
const L5: readonly string[] = ["text", "image/jpeg", "image/png", "application/pdf"]
const L6: readonly string[] = ["text", "image/jpeg", "image/png", "image/webp", "image/gif"]
const L7: readonly string[] = [
  "text",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
]
const L8: readonly string[] = ["text", "image"]
const L9: readonly string[] = [
  "text",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
  "audio/mp4",
  "audio/ogg",
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-ms-wmv",
]
const L10: readonly string[] = [
  "text",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/x-msvideo",
  "video/quicktime",
  "video/x-matroska",
]
const L11: readonly string[] = [
  "text",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "application/pdf",
  "audio/mpeg",
  "audio/wav",
]
const L12: readonly string[] = [
  "text",
  "image/bmp",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/heic",
  "video/mp4",
  "video/x-msvideo",
  "video/x-matroska",
  "video/quicktime",
  "video/x-flv",
  "video/x-ms-wmv",
]
const L13: readonly string[] = [
  "text",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
]

/** Live `modalities.input` per model id. */
export const LIVE_INPUT_MODALITIES: Readonly<Record<string, readonly string[]>> = {
  "beam-free": L0,
  "deepseek-v4-pro": L0,
  "glm-5.2": L0,
  "glm-5.3": L0,
  hy3: L0,
  "hy4-preview": L0,
  "iceman-contributor-free": L0,
  "longcat-2.0": L0,
  "claude-haiku-5-5": L1,
  "gpt-5.6-luna": L1,
  "gpt-6-luna": L1,
  "deepseek-v4.1-flash": L2,
  "gemini-4-argon": L3,
  "glm-5.3-flash": L4,
  "grok-4.7": L5,
  hy4: L6,
  "hy4-flash-free": L6,
  "kimi-k2.7-code": L7,
  "kimi-k3": L7,
  "kimi-k3.1-pro": L7,
  "longcat-2.5-free": L8,
  "mimo-v2.6-flash": L9,
  "mimo-v2.6-pro": L9,
  "minimax-m3": L10,
  "minimax-m3.1-flash": L10,
  "muse-spark-1.2-contributor": L11,
  "muse-spark-1.3-contributor": L11,
  "qwen3.7-plus": L12,
  "qwen3.8-flash": L12,
  "qwen3.8-max": L12,
  "qwen4-max": L12,
  "step-5-preview": L13,
}
