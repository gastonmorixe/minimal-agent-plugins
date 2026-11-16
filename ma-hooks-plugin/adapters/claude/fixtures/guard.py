#!/usr/bin/env python3
# Verbatim copy of the portability script in
# research/hooks-claude-vs-codex/REPORT.md section 4.1 (lines 320-337).
import json, sys

data = json.load(sys.stdin)
tool = data.get("tool_name", "")
tool_input = data.get("tool_input") or {}
SHELL = {"Bash"}  # Codex sends shell and exec_command calls as "Bash"

if data.get("hook_event_name") == "PreToolUse" and tool in SHELL:
    cmd = tool_input.get("command", "")
    if isinstance(cmd, list):
        cmd = " ".join(cmd)
    if "rm -rf /" in cmd:
        print("Blocked: rm -rf / is not allowed.", file=sys.stderr)
        sys.exit(2)
sys.exit(0)
