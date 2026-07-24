import {
  decodeFields,
  fieldBytes,
  fieldString,
  fieldVarint,
  getBool,
  getRepeatedMsg,
  getRepeatedString,
} from "./wire.ts"

export interface CursorModelParameterValue {
  id?: string
  value?: string
}

export interface CursorModelVariant {
  displayName?: string
  displayNameOutsidePicker?: string
  isMaxMode?: boolean
  isDefaultMaxConfig?: boolean
  isDefaultNonMaxConfig?: boolean
  tagline?: string
  variantStringRepresentation?: string
  legacySlug?: string
  parameterValues?: CursorModelParameterValue[]
}

export interface DecodedCursorModel {
  name: string
  defaultOn?: boolean
  isLongContextOnly?: boolean
  isChatOnly?: boolean
  supportsAgent?: boolean
  supportsThinking?: boolean
  supportsImages?: boolean
  supportsAutoContext?: boolean
  supportsMaxMode?: boolean
  supportsNonMaxMode?: boolean
  supportsPlanMode?: boolean
  supportsSandboxing?: boolean
  supportsCmdK?: boolean
  onlySupportsCmdK?: boolean
  contextTokenLimit?: number
  contextTokenLimitForMaxMode?: number
  autoContextMaxTokens?: number
  autoContextExtendedMaxTokens?: number
  clientDisplayName?: string
  serverModelName?: string
  inputboxShortModelName?: string
  isHidden?: boolean
  isUserAdded?: boolean
  degradationStatus?: number
  cloudAgentEffortMode?: number
  cloudAgentEffortModes?: number[]
  cloudMigrateToModel?: string
  upgradeModelId?: string
  legacySlugs?: string[]
  idAliases?: string[]
  variants?: CursorModelVariant[]
}

export interface DecodedAvailableModelsResponse {
  modelNames: string[]
  models: DecodedCursorModel[]
  useModelParameters?: boolean
}

function decodeParameterValue(buf: Uint8Array): CursorModelParameterValue {
  const value: CursorModelParameterValue = {}
  for (const field of decodeFields(buf)) {
    if (field.no === 1) value.id = fieldString(field) ?? undefined
    if (field.no === 2) value.value = fieldString(field) ?? undefined
  }
  return value
}

function decodeVariant(buf: Uint8Array): CursorModelVariant {
  const variant: CursorModelVariant = {}
  const parameterValues: CursorModelParameterValue[] = []
  for (const field of decodeFields(buf)) {
    switch (field.no) {
      case 1: {
        const bytes = fieldBytes(field)
        if (bytes) parameterValues.push(decodeParameterValue(bytes))
        break
      }
      case 2:
        variant.displayName = fieldString(field) ?? undefined
        break
      case 3:
        variant.isMaxMode = fieldVarint(field) !== 0
        break
      case 4:
        variant.isDefaultMaxConfig = fieldVarint(field) !== 0
        break
      case 5:
        variant.isDefaultNonMaxConfig = fieldVarint(field) !== 0
        break
      case 7:
        variant.tagline = fieldString(field) ?? undefined
        break
      case 8:
        variant.displayNameOutsidePicker = fieldString(field) ?? undefined
        break
      case 9:
        variant.variantStringRepresentation = fieldString(field) ?? undefined
        break
      case 11:
        variant.legacySlug = fieldString(field) ?? undefined
        break
    }
  }
  if (parameterValues.length > 0) variant.parameterValues = parameterValues
  return variant
}

/** Decode one AvailableModel protobuf message. */
export function decodeAvailableModel(buf: Uint8Array): DecodedCursorModel {
  const model: DecodedCursorModel = { name: "" }
  const variants: CursorModelVariant[] = []
  const effortModes: number[] = []
  for (const field of decodeFields(buf)) {
    const boolean = () => fieldVarint(field) !== 0
    switch (field.no) {
      case 1:
        model.name = fieldString(field) ?? ""
        break
      case 2:
        model.defaultOn = boolean()
        break
      case 3:
        model.isLongContextOnly = boolean()
        break
      case 4:
        model.isChatOnly = boolean()
        break
      case 5:
        model.supportsAgent = boolean()
        break
      case 6:
        model.degradationStatus = fieldVarint(field) ?? undefined
        break
      case 9:
        model.supportsThinking = boolean()
        break
      case 10:
        model.supportsImages = boolean()
        break
      case 11:
        model.supportsAutoContext = boolean()
        break
      case 12:
        model.autoContextMaxTokens = fieldVarint(field) ?? undefined
        break
      case 13:
        model.autoContextExtendedMaxTokens = fieldVarint(field) ?? undefined
        break
      case 14:
        model.supportsMaxMode = boolean()
        break
      case 15:
        model.contextTokenLimit = fieldVarint(field) ?? undefined
        break
      case 16:
        model.contextTokenLimitForMaxMode = fieldVarint(field) ?? undefined
        break
      case 17:
        model.clientDisplayName = fieldString(field) ?? undefined
        break
      case 18:
        model.serverModelName = fieldString(field) ?? undefined
        break
      case 19:
        model.supportsNonMaxMode = boolean()
        break
      case 22:
        model.supportsPlanMode = boolean()
        break
      case 23:
        model.isUserAdded = boolean()
        break
      case 24:
        model.inputboxShortModelName = fieldString(field) ?? undefined
        break
      case 25:
        model.supportsSandboxing = boolean()
        break
      case 26:
        model.supportsCmdK = boolean()
        break
      case 27:
        model.onlySupportsCmdK = boolean()
        break
      case 30: {
        const bytes = fieldBytes(field)
        if (bytes) variants.push(decodeVariant(bytes))
        break
      }
      case 32:
        model.cloudAgentEffortMode = fieldVarint(field) ?? undefined
        break
      case 33:
        model.cloudMigrateToModel = fieldString(field) ?? undefined
        break
      case 34:
        model.upgradeModelId = fieldString(field) ?? undefined
        break
      case 35:
        model.isHidden = boolean()
        break
      case 36: {
        const value = fieldString(field)
        if (value) (model.legacySlugs ??= []).push(value)
        break
      }
      case 37: {
        const value = fieldString(field)
        if (value) (model.idAliases ??= []).push(value)
        break
      }
      case 44: {
        const value = fieldVarint(field)
        if (value !== null) effortModes.push(value)
        break
      }
    }
  }
  if (variants.length > 0) model.variants = variants
  if (effortModes.length > 0) model.cloudAgentEffortModes = effortModes
  return model
}

/** Decode an AvailableModelsResponse protobuf body. */
export function decodeAvailableModelsResponse(buf: Uint8Array): DecodedAvailableModelsResponse {
  return {
    modelNames: getRepeatedString(buf, 1),
    models: getRepeatedMsg(buf, 2)
      .map(decodeAvailableModel)
      .filter((model) => model.name.length > 0),
    useModelParameters: getBool(buf, 11),
  }
}
