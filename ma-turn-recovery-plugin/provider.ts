/**
 * Synthetic text provider for tool results that core makes on a failure, a
 * stop, an abort or a policy denial. Texts are byte copies of the core texts.
 *
 * @module ma-turn-recovery-plugin/provider
 */

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

const KINDS: readonly SyntheticKind[] = [
  "tool_result.handler_error",
  "tool_result.interrupted_by_stop",
  "tool_result.aborted",
  "tool_result.policy_denied",
]

/** Copied from minimal-agent-core/src/plugins/loader/PROMPTS.ts:7-9 (pluginHandlerErrorResult). */
function handlerError(detail: string): string {
  return `Handler error: ${detail}`
}

/** Copied from minimal-agent-core/src/agent/PROMPTS.ts:63 (toolCallInterruptedByStopResult). */
const INTERRUPTED_BY_STOP =
  "The process stopped while this tool call ran. It may have run fully, partly, or not at all. Check its effects before you run it again."

/** Copied from minimal-agent-core/src/agent/PROMPTS.ts:54 (toolExecutionAbortedBeforeCompletionResult). */
const ABORTED_ORPHAN = "Tool execution aborted by user before completion."

/** Copied from minimal-agent-core/src/tools/PROMPTS.ts:58 (toolAbortedByUserResult). */
const ABORTED_RUNTIME = "tool aborted by user"

/** Copied from minimal-agent-core/src/adapters/lifecycle-port-adapter.ts:64 (tool.willInvoke default). */
const POLICY_DENIED_TOOL_WILL_INVOKE = "Tool blocked by lifecycle policy hook."

/** Create the provider. It throws on a kind it does not own or a fact it does not know. */
export function createTurnRecoveryProvider(): SyntheticTextProvider {
  return {
    kinds: KINDS,
    text(kind: SyntheticKind, facts: SyntheticFacts): string {
      switch (kind) {
        case "tool_result.handler_error": {
          if (typeof facts.detail !== "string")
            throw new Error("handler_error: detail must be a string")
          return handlerError(facts.detail)
        }
        case "tool_result.interrupted_by_stop":
          return INTERRUPTED_BY_STOP
        case "tool_result.aborted": {
          if (facts.site === "orphan") return ABORTED_ORPHAN
          if (facts.site === "runtime") return ABORTED_RUNTIME
          throw new Error(`aborted: unknown site ${String(facts.site)}`)
        }
        case "tool_result.policy_denied": {
          if (facts.hook === "tool.willInvoke") return POLICY_DENIED_TOOL_WILL_INVOKE
          throw new Error(`policy_denied: unknown hook ${String(facts.hook)}`)
        }
        default:
          throw new Error(`turn-recovery does not own kind ${kind}`)
      }
    },
  }
}
