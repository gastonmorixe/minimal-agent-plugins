/** One generated Cursor offline catalog row. */
export interface CursorStaticCatalogRow {
  id: string
  wireId: string
  displayName: string
  defaultOn: boolean
  supportsThinking: boolean
  supportsImages: boolean
  contextWindow: number
  maxOutputTokens: number
  effortLevels: readonly string[]
  speedFast?: boolean
  parentWireId?: string
  runModelId?: string
  defaultRunModelId?: string
  parameterValues?: ReadonlyArray<{ id: string; value: string }>
  defaultParameterValues?: ReadonlyArray<{ id: string; value: string }>
  effortParamId?: string
  fastParamId?: string
  maxMode?: boolean
  useVariantString?: boolean
}
