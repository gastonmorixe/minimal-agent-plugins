/**
 * AgentServerMessage.interaction_query (#7) and its reply,
 * AgentClientMessage.interaction_response (#6).
 *
 * The server asks the client to approve an action (web search, plan, mode
 * switch, image gen, ...). A client that never answers leaves the turn waiting
 * forever. MA is a headless bridge with no approval UI for these native
 * flows, so it answers every query with a rejection.
 *
 * Schema (CLI 2026.09.28, agent.v1):
 *
 * - InteractionQuery: field 1 is the uint32 id. The `query` oneof holds
 *   2 web_search, 3 ask_question, 4 switch_mode, 7 create_plan,
 *   8 setup_vm_environment, 9 web_fetch, 10 pr_management, 11 mcp_auth,
 *   12 generate_image, 13 replace_env, 14 connect_scm.
 * - InteractionResponse: field 1 is the uint32 id. The `result` oneof reuses
 *   the same field numbers as the query.
 * - WebSearchRequestResponse and SwitchModeRequestResponse: field 2 is
 *   `rejected`, and its field 1 is the string reason.
 *
 * Only web_search (2) and switch_mode (4) have a verified Rejected shape.
 * Other query kinds get an empty result message for the same oneof number
 * (Assumed: the server treats an unset result as a denial). Live effect of
 * that fallback is not verified.
 *
 * @module llm/providers/cursor/proto/interaction-query
 */

import {
  concat,
  decodeFields,
  encMsg,
  encString,
  encVarintField,
  fieldBytes,
  fieldVarint,
} from "./wire.ts"

/** AgentServerMessage.interaction_query field number. */
export const AGENT_SERVER_INTERACTION_QUERY_FIELD = 7
/** AgentClientMessage.interaction_response field number. */
export const AGENT_CLIENT_INTERACTION_RESPONSE_FIELD = 6

/** Query oneof case numbers that carry a verified `rejected { reason }` (#2). */
const REJECTABLE_QUERY_FIELDS = new Set([2, 4])

/** Known InteractionQuery oneof field numbers. */
const KNOWN_QUERY_FIELDS = new Set([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14])

export type DecodedInteractionQuery = {
  /** InteractionQuery.id, echoed in the response. */
  id: number
  /** Which `query` oneof member the server sent (0 when none recognized). */
  queryField: number
}

/**
 * Decode `AgentServerMessage.interaction_query` from one Connect payload.
 * Returns undefined when the payload has no interaction_query.
 */
export function decodeInteractionQuery(payload: Uint8Array): DecodedInteractionQuery | undefined {
  const outer = decodeFields(payload).find((f) => f.no === AGENT_SERVER_INTERACTION_QUERY_FIELD)
  if (!outer) return undefined
  const body = fieldBytes(outer)
  if (!body) return undefined
  const fields = decodeFields(body)
  const idField = fields.find((f) => f.no === 1)
  const id = idField ? (fieldVarint(idField) ?? 0) : 0
  const queryField = fields.find((f) => KNOWN_QUERY_FIELDS.has(f.no))?.no ?? 0
  return { id, queryField }
}

/**
 * Encode `AgentClientMessage.interaction_response` rejecting the query.
 * The result oneof reuses the query's field number.
 */
export function encodeInteractionRejection(
  query: DecodedInteractionQuery,
  reason = "minimal-agent cannot approve interactive Cursor-native requests",
): Uint8Array {
  const idField = encVarintField(1, query.id)
  if (query.queryField === 0) {
    return encMsg(AGENT_CLIENT_INTERACTION_RESPONSE_FIELD, idField)
  }
  const result = REJECTABLE_QUERY_FIELDS.has(query.queryField)
    ? encMsg(2, encString(1, reason))
    : new Uint8Array(0)
  return encMsg(
    AGENT_CLIENT_INTERACTION_RESPONSE_FIELD,
    concat(idField, encMsg(query.queryField, result)),
  )
}
