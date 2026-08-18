/**
 * Per-host-id wire encode spec for AgentService/Run RequestedModel.
 *
 * The host may pass a stale ModelView from boot; live catalog refresh writes
 * here so `buildCursorAgentRunBody` always encodes the current Run SKU.
 *
 * Current encoder prefers exploded legacy slugs (`cursor-grok-4.6-high`).
 * Cursor Agent CLI still sends parent + RequestedModel.parameters (`grok-4.6`
 * + effort/fast); that shape is valid on CLI. MA’s parent+params path was
 * `not_found` while we also sent IDE checksum headers — see
 * `docs/agent-run-too-many-computers-postmortem.md` before changing this.
 *
 * @module llm/providers/cursor/encode-spec
 */

export type CursorParameterValue = {
  id: string
  value: string
}

export type CursorSkuLookup = {
  effort?: string
  fast?: boolean
}

export type CursorEncodeSpec = {
  /**
   * Catalog identity: parent API name (`grok-4.6`) or variant-string when
   * `useVariantString`. Not always the Run model_id.
   */
  wireId: string
  /**
   * Exact AgentService/Run `RequestedModel.model_id` for exploded SKU rows.
   * Omit on parents — encode resolves via {@link lookupCursorRunSku}.
   */
  runModelId?: string
  /** Parent API name used as the SKU index key (`grok-4.6`). */
  parentApiId?: string
  /** Default-non-max variant SKU when the parent is selected with no params. */
  defaultRunModelId?: string
  /** Baked variant parameters (effort/fast/thinking/context/…). */
  parameterValues: readonly CursorParameterValue[]
  /** Parent-only extras from the catalog default-non-max variant. */
  defaultParameterValues: readonly CursorParameterValue[]
  /** RequestedModel.max_mode. */
  maxMode: boolean
  /**
   * When true, send `is_variant_string_representation` and use `wireId` as the
   * variant string. Never combine with a SKU `runModelId`.
   */
  useVariantString: boolean
  effortParamId?: string
  fastParamId?: string
  effortLevels: readonly string[]
  speedFast: boolean
}

const specs = new Map<string, CursorEncodeSpec>()
/** parent + effort/fast fingerprint → exploded Run SKU. */
const skuIndex = new Map<string, string>()

function skuKey(parent: string, opts: CursorSkuLookup): string {
  const bits = [parent]
  if (opts.effort) bits.push(`effort=${opts.effort}`)
  if (opts.fast === true) bits.push("fast=true")
  else if (opts.fast === false) bits.push("fast=false")
  return bits.join("|")
}

/** Replace the encode spec for a host model id (last-write-wins). */
export function setCursorEncodeSpec(hostId: string, spec: CursorEncodeSpec): void {
  specs.set(hostId, spec)
}

/** Look up the current encode spec, if the catalog has registered this id. */
export function getCursorEncodeSpec(hostId: string): CursorEncodeSpec | undefined {
  return specs.get(hostId)
}

/**
 * Index an exploded Run SKU under a parent API name so parent rows can map
 * CanonicalRequest.effort / speed onto the matching legacy slug.
 */
export function registerCursorRunSku(
  parentApiId: string,
  opts: CursorSkuLookup,
  sku: string,
): void {
  if (!parentApiId || !sku) return
  skuIndex.set(skuKey(parentApiId, opts), sku)
  // Effort-only lookup prefers the non-fast SKU when both exist.
  if (opts.effort && opts.fast !== true) {
    skuIndex.set(skuKey(parentApiId, { effort: opts.effort }), sku)
  }
}

/** Resolve an exploded Run SKU from parent + effort/fast. */
export function lookupCursorRunSku(parentApiId: string, opts: CursorSkuLookup): string | undefined {
  if (!parentApiId) return undefined
  if (opts.effort !== undefined && opts.fast !== undefined) {
    const exact = skuIndex.get(skuKey(parentApiId, opts))
    if (exact) return exact
  }
  if (opts.effort !== undefined) {
    const effortOnly = skuIndex.get(skuKey(parentApiId, { effort: opts.effort }))
    if (effortOnly) return effortOnly
  }
  if (opts.fast !== undefined && opts.effort === undefined) {
    const fastOnly = skuIndex.get(skuKey(parentApiId, { fast: opts.fast }))
    if (fastOnly) return fastOnly
  }
  return skuIndex.get(skuKey(parentApiId, {}))
}

/** Test helper: drop the in-memory spec map and SKU index. */
export function resetCursorEncodeSpecsForTests(): void {
  specs.clear()
  skuIndex.clear()
}

/** Build a spec from registration fields. */
export function makeCursorEncodeSpec(input: {
  wireId: string
  runModelId?: string
  parentApiId?: string
  defaultRunModelId?: string
  parameterValues?: readonly CursorParameterValue[]
  defaultParameterValues?: readonly CursorParameterValue[]
  maxMode?: boolean
  useVariantString?: boolean
  effortParamId?: string
  fastParamId?: string
  effortLevels?: readonly string[]
  speedFast?: boolean
}): CursorEncodeSpec {
  const parameterValues = input.parameterValues ?? []
  return {
    wireId: input.wireId,
    runModelId: input.runModelId,
    parentApiId: input.parentApiId,
    defaultRunModelId: input.defaultRunModelId,
    parameterValues,
    defaultParameterValues: input.defaultParameterValues ?? [],
    maxMode: input.maxMode ?? false,
    useVariantString: Boolean(input.useVariantString) && parameterValues.length === 0,
    effortParamId: input.effortParamId,
    fastParamId: input.fastParamId,
    effortLevels: input.effortLevels ?? [],
    speedFast: input.speedFast ?? false,
  }
}
