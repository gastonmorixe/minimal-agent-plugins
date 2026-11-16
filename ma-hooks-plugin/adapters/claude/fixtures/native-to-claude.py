#!/usr/bin/env python3
# Test shim: turn the native stdin envelope ({channel, payload, ...}) into the
# Claude PreToolUse fields guard.py reads, so the same unchanged guard script
# runs from a native hooks.json. Prints the Claude JSON on stdout.
import json, sys

env = json.load(sys.stdin)
payload = env.get("payload") or {}
event = "PreToolUse" if env.get("channel") == "tool.willInvoke" else env.get("channel", "")
json.dump(
    {
        "session_id": env.get("sid", ""),
        "cwd": env.get("cwd", ""),
        "hook_event_name": event,
        "tool_name": payload.get("tool", ""),
        "tool_input": payload.get("input") or {},
    },
    sys.stdout,
)
