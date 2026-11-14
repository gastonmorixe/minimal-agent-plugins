/**
 * Text of an error for the ACP protocol fields (JSON-RPC error message,
 * notice description, stderr).
 *
 * Core errors have an EMPTY `message`. They carry a `kind` string and typed
 * fields. This plugin has only a peerDependency on core, so it reads them by
 * shape (no core import) and writes the text itself. The wording matches the
 * old core text (see the CLI `startup/core-text.ts`).
 *
 * @module error-text
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
 * Text of an error. A non-empty `message` wins. Else a known core kind gets
 * its text. Any other typed error shows the kind name.
 */
export function errorText(e: unknown): string {
  const raw = e !== null && typeof e === "object" ? (e as { message?: unknown }).message : undefined
  const message = typeof raw === "string" ? raw : e instanceof Error ? "" : String(e)
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
    case "SignInTimeoutError":
      return "Sign-in timed out. Run login again."
    case "InvalidAuthorizationCodeError":
      return "Authentication failed: invalid authorization code"
    case "TokenExchangeError":
      return `Token exchange failed (${str(f.status)}): ${str(f.body)}`
    case "NoOAuthLoginProviderError":
      return "No OAuth login provider is registered."
    default:
      return typed.kind
  }
}
