/**
 * Text for a failed `ctx.host.llm.complete` call.
 *
 * Core auth errors have an EMPTY `message`. They carry a `kind` string and
 * typed fields. The plugin reads them by shape (no core import) and writes
 * the text itself. Wording matches the old core text.
 *
 * @module lib/error-text
 */

interface StoredProviderFact {
  providerId?: unknown
  labels?: unknown
  exampleModels?: unknown
}

const NO_CREDENTIALS_HINT =
  "No provider credentials found. Run `minimal-agent provider <id> login` " +
  "(e.g. `minimal-agent provider example-provider login`)."

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v)
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str) : []
}

function providersHint(v: unknown): string {
  const list = Array.isArray(v) ? (v as StoredProviderFact[]) : []
  if (list.length === 0) return NO_CREDENTIALS_HINT
  const lines = list.map((p) => {
    const examples = strList(p.exampleModels)
    const tail =
      examples.length > 0 ? ` \u2014 e.g. ${examples.map((id) => `"${id}"`).join(", ")}` : ""
    return `${str(p.providerId)} (${strList(p.labels).join(", ")})${tail}`
  })
  return (
    `Logged in: ${lines.join("; ")}. ` +
    `Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.`
  )
}

/** Read `{kind, fields}` from an error by shape. Undefined when not a typed error. */
function readKind(e: unknown): { kind: string; fields: Record<string, unknown> } | undefined {
  if (e === null || typeof e !== "object") return undefined
  const o = e as { kind?: unknown; toJSON?: unknown }
  if (typeof o.kind !== "string") return undefined
  let fields: Record<string, unknown> = {}
  if (typeof o.toJSON === "function") {
    const json = (o.toJSON as () => { fields?: unknown })()
    if (json && typeof json.fields === "object" && json.fields !== null) {
      fields = json.fields as Record<string, unknown>
    }
  } else {
    fields = e as Record<string, unknown>
  }
  return { kind: o.kind, fields }
}

/**
 * Text of an error. A known core auth kind gets its text. An unknown kind
 * with an empty message shows the kind name. Else the message.
 */
export function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  if (message !== "") return message
  const typed = readKind(e)
  if (!typed) return message
  const f = typed.fields
  switch (typed.kind) {
    case "NoProviderSelectedError":
      return `no provider selected for model "${str(f.modelId)}". ${providersHint(f.credentialedProviders)}`
    case "NoProviderCredentialsError":
      return (
        `no credentials for provider "${str(f.providerId)}" (model "${str(f.modelId)}"). ` +
        `Run minimal-agent provider ${str(f.providerId)} login. ${providersHint(f.credentialedProviders)}`
      )
    case "GenericEndpointAuthError":
      return `generic-endpoint auth-type ${str(f.authType)} requires --${str(f.missing)}`
    case "UnhandledAuthTypeError":
      return `unhandled generic-endpoint auth-type: ${str(f.authType)}`
    default:
      return typed.kind
  }
}
