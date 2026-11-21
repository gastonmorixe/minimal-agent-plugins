/**
 * Char-class token-estimate presets: one {@link CharClassEstimatorParams}
 * for each tokenizer family.
 *
 * The values come from `scripts/token-estimate-calibrate.ts` (see
 * `README.md`). MAPE is the mean absolute percentage error on held-out
 * samples (about 20%). "Old ratio" is the fixed chars/token ratio before
 * this kit: 3.5 for Anthropic and Grok, 4 for OpenAI, 3.8 for all others.
 *
 * This file holds data only. The estimator is the core
 * `makeCharClassEstimator`.
 *
 * @module presets
 */

import type { CharClassEstimatorParams } from "@minimal-agent/core/plugin-api/llm/token-estimate"

/** Tokenizer families of the kit. */
export type TokenizerFamily =
  | "claude-legacy"
  | "claude-5x"
  | "openai-o200k"
  | "openai-cl100k"
  | "gemma"
  | "llama3"
  | "llama4"
  | "qwen"
  | "deepseek"
  | "mistral"
  | "glm"
  | "kimi"
  | "minimax"
  | "grok"
  | "meta-muse"
  | "generic"

/**
 * Claude 4.7 and later (all Claude 5.x): the new Anthropic tokenizer.
 *
 * Data: real Anthropic usage in local minimal-agent sessions. A sample is the
 * input-token delta between two assistant turns (input + cache read + cache
 * creation, minus the previous output) over the tool-result TEXT between them.
 * The fit uses text content, not request JSON: the request JSON has escapes
 * and structure that change the char mix (about 2.5 JSON bytes/token in
 * net-dbg captures, but about 2.3 text chars/token in the session deltas).
 * The CJK and other weights come from the generic fit (tool results have too
 * little non-ASCII text).
 * Fit: 1502 samples, 290 held out (split by session file). Held-out MAPE (3.5 ratio to this preset): 34.9% to 9.8%.
 */
export const CLAUDE_5X_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 3.09,
  shortWordMaxChars: 0,
  digitCharsPerToken: 1.869,
  punctCharsPerToken: 3.779,
  whitespaceCharsPerToken: 115.196,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.694,
  scale: 0.99,
}

/**
 * Claude 4.6 and earlier: the old Anthropic tokenizer.
 *
 * No fit: there is too little local data. Anthropic publishes that the new
 * tokenizer (Claude 4.7 and later) gives about 1.0x to 1.35x more tokens for
 * the same text. This preset is {@link CLAUDE_5X_PARAMS} with the scale
 * divided by 1.2 (the middle of that band). A check on 128 local Claude
 * 4.5/4.6 session samples gives MAPE 12.7% (bias -0.1%), against 31.5% for
 * the old 3.5 ratio (22 held-out samples).
 */
export const CLAUDE_LEGACY_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 3.09,
  shortWordMaxChars: 0,
  digitCharsPerToken: 1.869,
  punctCharsPerToken: 3.779,
  whitespaceCharsPerToken: 115.196,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.694,
  scale: 0.825,
}

/**
 * OpenAI o200k (gpt-4o, gpt-4.1, gpt-5.x, gpt-6.x, o-series, gpt-oss).
 *
 * Tokenizer: o200k_base. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 14.9% to 5.3%.
 */
export const OPENAI_O200K_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 12.288,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 18.75,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.694,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 2.5 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 6.25 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 3.75 },
  ],
  scale: 0.99,
}

/**
 * OpenAI cl100k (gpt-4, gpt-3.5).
 *
 * Tokenizer: cl100k_base. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 16.9% to 5.1%.
 */
export const OPENAI_CL100K_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 12.288,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3.337,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 18.75,
  cjkCharsPerToken: 0.874,
  otherCharsPerToken: 0.533,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 0.617 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 2.384 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 1.389 },
  ],
  scale: 0.99,
}

/**
 * Google Gemma, also used for Gemini.
 *
 * Tokenizer: Gemma 3. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 19.6% to 4.5%.
 *
 * There is no Gemini data: Gemini uses a SentencePiece vocabulary of the same
 * size as Gemma, so this preset is an assumption for Gemini.
 */
export const GEMMA_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 7.031,
  shortWordMaxChars: 0,
  digitCharsPerToken: 1.158,
  punctCharsPerToken: 2.975,
  whitespaceCharsPerToken: 16.796,
  cjkCharsPerToken: 1.717,
  otherCharsPerToken: 1.728,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 2.5 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 6.75 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 3.375 },
  ],
}

/**
 * Meta Llama 3.x.
 *
 * Tokenizer: Llama 3.3. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 13.4% to 5.4%.
 */
export const LLAMA3_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 12.288,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 18.75,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.533,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 0.617 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 4.34 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 2.778 },
  ],
  scale: 0.99,
}

/**
 * Meta Llama 4.
 *
 * Tokenizer: Llama 4. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 13.9% to 5.6%.
 */
export const LLAMA4_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 12.288,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 18.75,
  cjkCharsPerToken: 2.005,
  otherCharsPerToken: 0.66,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 2.5 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 7.873 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 3.125 },
  ],
  scale: 0.99,
}

/**
 * Qwen (Qwen3 and later).
 *
 * Tokenizer: Qwen3. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 15.7% to 4.7%.
 */
export const QWEN_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 12.288,
  shortWordMaxChars: 0,
  digitCharsPerToken: 1.2,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 18.75,
  cjkCharsPerToken: 1.486,
  otherCharsPerToken: 1.166,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 0.617 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 3.75 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 2.916 },
  ],
  scale: 0.99,
}

/**
 * DeepSeek (V3 and later).
 *
 * Tokenizer: DeepSeek-V3.1. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 14.3% to 4.3%.
 */
export const DEEPSEEK_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 8.192,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.673,
  whitespaceCharsPerToken: 68.344,
  cjkCharsPerToken: 1.651,
  otherCharsPerToken: 0.764,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 2 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 5.063 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 3.125 },
  ],
  scale: 1.01,
}

/**
 * Mistral (Mistral, Devstral, Codestral, Magistral).
 *
 * Tokenizer: Tekken (Devstral). Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 17.3% to 5.5%.
 */
export const MISTRAL_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 10.125,
  shortWordMaxChars: 0,
  digitCharsPerToken: 1.029,
  punctCharsPerToken: 3.976,
  whitespaceCharsPerToken: 30.375,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.357,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 2.5 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 5.063 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 4.688 },
  ],
  scale: 1.01,
}

/**
 * Z.ai GLM.
 *
 * Tokenizer: GLM-4.6. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 14.0% to 5.0%.
 */
export const GLM_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 11.488,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 18.75,
  cjkCharsPerToken: 1.416,
  otherCharsPerToken: 0.533,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 1.667 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 5.794 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 2.647 },
  ],
  scale: 0.99,
}

/**
 * Moonshot Kimi.
 *
 * Tokenizer: Kimi K2. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 14.4% to 5.7%.
 */
export const KIMI_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 11.81,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 68.344,
  cjkCharsPerToken: 1.416,
  otherCharsPerToken: 0.561,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 0.617 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 3.125 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 2.083 },
  ],
  scale: 0.99,
}

/**
 * MiniMax.
 *
 * Tokenizer: MiniMax-M2. Data: exact token counts of the public tokenizer on the reference corpus (code, markdown, JSON, tool schemas, agent tool results, prose in 9 languages, emoji).
 * Fit: 562 samples, 113 held out. Held-out MAPE (old ratio to this preset): 13.1% to 5.3%.
 */
export const MINIMAX_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 12.288,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 18.75,
  cjkCharsPerToken: 2.105,
  otherCharsPerToken: 0.989,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 2.5 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 4.292 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 4.42 },
  ],
}

/**
 * xAI Grok (grok-4.x).
 *
 * Data: real xAI usage in local minimal-agent sessions (input_tokens
 * includes the cached tokens). The sample is the input-token delta over the
 * tool-result text between two assistant turns. The CJK and other weights
 * come from the generic fit. The public Grok-2 tokenizer is older; its fit
 * on the reference corpus has held-out MAPE 16.9% to 4.8%, but the
 * live grok-4.x data is a better match.
 * Fit: 1500 samples, 349 held out (split by session file). Held-out MAPE (3.5 ratio to this preset): 15.5% to 10.8%.
 */
export const GROK_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 10.025,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3.298,
  punctCharsPerToken: 15.326,
  whitespaceCharsPerToken: 16.858,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.694,
  scale: 1.01,
}

/**
 * Meta Muse (muse-spark, muse-wonder, muse-ember).
 *
 * Data: real Meta usage in local minimal-agent sessions (meta and opencode
 * providers; input_tokens includes the cached tokens). There is no public
 * tokenizer. The CJK and other weights come from the generic fit. The
 * session deltas have more noise than for the other providers.
 * Fit: 1501 samples, 257 held out (split by session file). Held-out MAPE (3.8 ratio to this preset): 17.5% to 14.8%.
 */
export const META_MUSE_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 8.03,
  shortWordMaxChars: 0,
  digitCharsPerToken: 1.912,
  punctCharsPerToken: 6.924,
  whitespaceCharsPerToken: 187.85,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.694,
  scale: 0.801,
}

/**
 * Generic: an unknown tokenizer.
 *
 * Data: the union of the 12 reference tokenizers (o200k, cl100k, Qwen,
 * DeepSeek, GLM, Kimi, Llama 3, Llama 4, Gemma, Mistral, MiniMax, Grok-2).
 * Each tokenizer has the same total weight in the fit.
 * Fit: 6744 samples, 1356 held out. Held-out MAPE (3.8 ratio to this preset): 15.2% to 7.3%.
 */
export const GENERIC_PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 10.125,
  shortWordMaxChars: 0,
  digitCharsPerToken: 3,
  punctCharsPerToken: 15.943,
  whitespaceCharsPerToken: 68.344,
  cjkCharsPerToken: 1.5,
  otherCharsPerToken: 0.694,
  scripts: [
    { from: 0x00c0, to: 0x024f, charsPerToken: 2.5 },
    { from: 0x0400, to: 0x04ff, charsPerToken: 4.688 },
    { from: 0x0600, to: 0x06ff, charsPerToken: 3.125 },
  ],
}

/** All presets, by family. */
export const TOKENIZER_PRESETS: Readonly<Record<TokenizerFamily, CharClassEstimatorParams>> = {
  "claude-legacy": CLAUDE_LEGACY_PARAMS,
  "claude-5x": CLAUDE_5X_PARAMS,
  "openai-o200k": OPENAI_O200K_PARAMS,
  "openai-cl100k": OPENAI_CL100K_PARAMS,
  gemma: GEMMA_PARAMS,
  llama3: LLAMA3_PARAMS,
  llama4: LLAMA4_PARAMS,
  qwen: QWEN_PARAMS,
  deepseek: DEEPSEEK_PARAMS,
  mistral: MISTRAL_PARAMS,
  glm: GLM_PARAMS,
  kimi: KIMI_PARAMS,
  minimax: MINIMAX_PARAMS,
  grok: GROK_PARAMS,
  "meta-muse": META_MUSE_PARAMS,
  generic: GENERIC_PARAMS,
}

/** All family names, in a fixed order. */
export const TOKENIZER_FAMILIES: readonly TokenizerFamily[] = Object.keys(
  TOKENIZER_PRESETS,
) as TokenizerFamily[]
