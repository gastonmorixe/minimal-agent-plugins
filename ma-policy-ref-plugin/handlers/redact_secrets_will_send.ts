/**
 * `message.willSend` — redact `sk-…` API-key shaped tokens in message text.
 *
 * @module handlers/redact_secrets_will_send
 */

export interface SendSnapshot {
  messages: Array<{ role: string; content: unknown }>
  system: string | Array<{ type: string; text?: string }>
  model: string
  providerId?: string
}

const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g

/** Replace sk- tokens in a string. */
function redactText(s: string): string {
  return s.replace(SK_RE, "sk-[REDACTED]")
}

/** Walk message content (string or blocks) and redact secrets. */
function redactContent(content: unknown): unknown {
  if (typeof content === "string") return redactText(content)
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block && typeof block === "object" && "type" in block) {
      const b = block as { type: string; text?: string }
      if (b.type === "text" && typeof b.text === "string") {
        return { ...b, text: redactText(b.text) }
      }
    }
    return block
  })
}

/**
 * HookBus message.willSend handler (default export for the manifest).
 *
 * @param payload - Outgoing send snapshot.
 * @returns Snapshot with secrets redacted.
 */
export default function redactSecretsWillSend(payload: SendSnapshot): SendSnapshot {
  const messages = payload.messages.map((m) => ({
    ...m,
    content: redactContent(m.content),
  }))
  let system = payload.system
  if (typeof system === "string") {
    system = redactText(system)
  } else if (Array.isArray(system)) {
    system = system.map((b) =>
      b && typeof b === "object" && typeof b.text === "string"
        ? { ...b, text: redactText(b.text) }
        : b,
    )
  }
  return { ...payload, messages, system }
}
