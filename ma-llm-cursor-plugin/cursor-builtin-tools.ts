/**
 * Cursor AgentService/Run built-in ToolCall oneof catalog.
 *
 * Sourced from agent.v1.ToolCall (Cursor CLI bundle 2026.07.23). Used to build
 * `x-cursor-agent-exclude-tools` so MA tools ride MCP (`mcp_tool_call`) instead
 * of Cursor-native grep/shell/read oneofs.
 *
 * @module llm/providers/cursor/cursor-builtin-tools
 */

/** One built-in ToolCall oneof member from agent.v1.ToolCall. */
export type CursorBuiltinToolEntry = {
  fieldNumber: number
  /** snake_case proto field name (e.g. `grep_tool_call`). */
  protoName: string
  /** camelCase oneof case (e.g. `grepToolCall`). */
  oneofCase: string
}

/**
 * Full ToolCall oneof catalog (2026.07.23 bundle). Keep in sync when Cursor adds tools.
 * Research snapshot: ~/Projects/cursor/jul-28/raw/toolcall-oneof-catalog.json
 */
export const CURSOR_BUILTIN_TOOL_CATALOG: readonly CursorBuiltinToolEntry[] = [
  { fieldNumber: 1, protoName: "shell_tool_call", oneofCase: "shellToolCall" },
  { fieldNumber: 3, protoName: "delete_tool_call", oneofCase: "deleteToolCall" },
  { fieldNumber: 4, protoName: "glob_tool_call", oneofCase: "globToolCall" },
  { fieldNumber: 5, protoName: "grep_tool_call", oneofCase: "grepToolCall" },
  { fieldNumber: 8, protoName: "read_tool_call", oneofCase: "readToolCall" },
  { fieldNumber: 9, protoName: "update_todos_tool_call", oneofCase: "updateTodosToolCall" },
  { fieldNumber: 10, protoName: "read_todos_tool_call", oneofCase: "readTodosToolCall" },
  { fieldNumber: 12, protoName: "edit_tool_call", oneofCase: "editToolCall" },
  { fieldNumber: 13, protoName: "ls_tool_call", oneofCase: "lsToolCall" },
  { fieldNumber: 14, protoName: "read_lints_tool_call", oneofCase: "readLintsToolCall" },
  { fieldNumber: 15, protoName: "mcp_tool_call", oneofCase: "mcpToolCall" },
  { fieldNumber: 16, protoName: "sem_search_tool_call", oneofCase: "semSearchToolCall" },
  { fieldNumber: 17, protoName: "create_plan_tool_call", oneofCase: "createPlanToolCall" },
  { fieldNumber: 18, protoName: "web_search_tool_call", oneofCase: "webSearchToolCall" },
  { fieldNumber: 19, protoName: "task_tool_call", oneofCase: "taskToolCall" },
  {
    fieldNumber: 20,
    protoName: "list_mcp_resources_tool_call",
    oneofCase: "listMcpResourcesToolCall",
  },
  {
    fieldNumber: 21,
    protoName: "read_mcp_resource_tool_call",
    oneofCase: "readMcpResourceToolCall",
  },
  { fieldNumber: 22, protoName: "apply_agent_diff_tool_call", oneofCase: "applyAgentDiffToolCall" },
  { fieldNumber: 23, protoName: "ask_question_tool_call", oneofCase: "askQuestionToolCall" },
  { fieldNumber: 24, protoName: "fetch_tool_call", oneofCase: "fetchToolCall" },
  { fieldNumber: 25, protoName: "switch_mode_tool_call", oneofCase: "switchModeToolCall" },
  { fieldNumber: 28, protoName: "generate_image_tool_call", oneofCase: "generateImageToolCall" },
  { fieldNumber: 29, protoName: "record_screen_tool_call", oneofCase: "recordScreenToolCall" },
  { fieldNumber: 30, protoName: "computer_use_tool_call", oneofCase: "computerUseToolCall" },
  {
    fieldNumber: 31,
    protoName: "write_shell_stdin_tool_call",
    oneofCase: "writeShellStdinToolCall",
  },
  { fieldNumber: 32, protoName: "reflect_tool_call", oneofCase: "reflectToolCall" },
  {
    fieldNumber: 33,
    protoName: "setup_vm_environment_tool_call",
    oneofCase: "setupVmEnvironmentToolCall",
  },
  { fieldNumber: 34, protoName: "truncated_tool_call", oneofCase: "truncatedToolCall" },
  {
    fieldNumber: 35,
    protoName: "start_grind_execution_tool_call",
    oneofCase: "startGrindExecutionToolCall",
  },
  {
    fieldNumber: 36,
    protoName: "start_grind_planning_tool_call",
    oneofCase: "startGrindPlanningToolCall",
  },
  { fieldNumber: 37, protoName: "web_fetch_tool_call", oneofCase: "webFetchToolCall" },
  {
    fieldNumber: 38,
    protoName: "report_bugfix_results_tool_call",
    oneofCase: "reportBugfixResultsToolCall",
  },
  { fieldNumber: 39, protoName: "ai_attribution_tool_call", oneofCase: "aiAttributionToolCall" },
  { fieldNumber: 40, protoName: "pr_management_tool_call", oneofCase: "prManagementToolCall" },
  { fieldNumber: 41, protoName: "mcp_auth_tool_call", oneofCase: "mcpAuthToolCall" },
  { fieldNumber: 42, protoName: "await_tool_call", oneofCase: "awaitToolCall" },
  {
    fieldNumber: 43,
    protoName: "blame_by_file_path_tool_call",
    oneofCase: "blameByFilePathToolCall",
  },
  { fieldNumber: 44, protoName: "get_mcp_tools_tool_call", oneofCase: "getMcpToolsToolCall" },
  { fieldNumber: 45, protoName: "report_bug_tool_call", oneofCase: "reportBugToolCall" },
  {
    fieldNumber: 46,
    protoName: "set_active_branch_tool_call",
    oneofCase: "setActiveBranchToolCall",
  },
  {
    fieldNumber: 48,
    protoName: "communicate_update_tool_call",
    oneofCase: "communicateUpdateToolCall",
  },
  {
    fieldNumber: 49,
    protoName: "send_final_summary_tool_call",
    oneofCase: "sendFinalSummaryToolCall",
  },
  {
    fieldNumber: 50,
    protoName: "update_pr_code_tour_tool_call",
    oneofCase: "updatePrCodeTourToolCall",
  },
  { fieldNumber: 51, protoName: "replace_env_tool_call", oneofCase: "replaceEnvToolCall" },
  { fieldNumber: 52, protoName: "edit_pr_labels_tool_call", oneofCase: "editPrLabelsToolCall" },
  {
    fieldNumber: 53,
    protoName: "record_ci_investigation_findings_tool_call",
    oneofCase: "recordCiInvestigationFindingsToolCall",
  },
  { fieldNumber: 55, protoName: "send_message_tool_call", oneofCase: "sendMessageToolCall" },
  {
    fieldNumber: 56,
    protoName: "fetch_cloud_agent_data_tool_call",
    oneofCase: "fetchCloudAgentDataToolCall",
  },
  { fieldNumber: 58, protoName: "send_to_user_tool_call", oneofCase: "sendToUserToolCall" },
  { fieldNumber: 61, protoName: "pi_read_tool_call", oneofCase: "piReadToolCall" },
  { fieldNumber: 62, protoName: "pi_bash_tool_call", oneofCase: "piBashToolCall" },
  { fieldNumber: 63, protoName: "pi_edit_tool_call", oneofCase: "piEditToolCall" },
  { fieldNumber: 64, protoName: "pi_write_tool_call", oneofCase: "piWriteToolCall" },
  { fieldNumber: 65, protoName: "pi_grep_tool_call", oneofCase: "piGrepToolCall" },
  { fieldNumber: 66, protoName: "pi_find_tool_call", oneofCase: "piFindToolCall" },
  { fieldNumber: 67, protoName: "pi_ls_tool_call", oneofCase: "piLsToolCall" },
  { fieldNumber: 68, protoName: "connect_scm_tool_call", oneofCase: "connectScmToolCall" },
  {
    fieldNumber: 69,
    protoName: "search_conversations_tool_call",
    oneofCase: "searchConversationsToolCall",
  },
] as const

/** MCP oneof — the only built-in we keep when advertising MA tools via MCP. */
export const CURSOR_MCP_TOOL_ONEOF = "mcpToolCall" as const

const VALID_ONEOF = new Set(CURSOR_BUILTIN_TOOL_CATALOG.map((e) => e.oneofCase))
const VALID_PROTO = new Set(CURSOR_BUILTIN_TOOL_CATALOG.map((e) => e.protoName))

/** True when `name` is a known ToolCall oneof case or proto_name. */
export function isValidCursorBuiltinToolName(name: string): boolean {
  return VALID_ONEOF.has(name) || VALID_PROTO.has(name)
}

/**
 * Built-in tools to exclude on the wire.
 *
 * @param allowMcp - when true, omit `mcpToolCall` from the exclude list so MCP
 *   definitions in `AgentRunRequest.mcp_tools` can be invoked.
 */
export function cursorBuiltinToolsToExclude(allowMcp: boolean): string[] {
  return CURSOR_BUILTIN_TOOL_CATALOG.filter(
    (e) => !(allowMcp && e.oneofCase === CURSOR_MCP_TOOL_ONEOF),
  ).map((e) => e.oneofCase)
}
