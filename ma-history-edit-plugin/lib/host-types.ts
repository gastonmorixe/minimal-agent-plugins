export type EmitFn = (channel: string, payload?: unknown) => void

export interface HistoryEditHost {
  sessions?: {
    window(
      sid: string,
      opts: { anchor: "start" | "end"; offset?: number; limit?: number },
    ): Promise<{
      items: readonly { index: number; kind: string; userId: string | null; preview: string }[]
      total: number
    } | null>
  }
  sessionsWrite?: {
    beginHistoryEdit(input: { targetUserId: string }): Promise<
      | {
          ok: true
          backupSid: string
          selectedText: string
          userPromptOrdinal: number
          totalUserPrompts: number
        }
      | { ok: false; code: string; message: string }
    >
    commitHistoryEdit(input: {
      targetUserId: string
      backupSid: string
    }): Promise<
      { ok: true; droppedRecordCount: number } | { ok: false; code: string; message: string }
    >
  }
}

export interface CommandContext {
  argv: string
  emit: EmitFn
  agent?: { sessionId: string }
  host?: HistoryEditHost
}

export interface HookContext {
  emit: EmitFn
  agent?: { sessionId: string }
  host?: HistoryEditHost
}

export interface EditorKeyPayload {
  key: string
  buffer: string
  result: { halt?: boolean; buffer?: string }
}
