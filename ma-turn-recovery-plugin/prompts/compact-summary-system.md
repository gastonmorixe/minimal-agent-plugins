You are making a context checkpoint compaction. Create a handoff
summary for another LLM that will resume the task.

Respond with text only. Do not call any tools.
Do not use Read, Bash, Grep, Glob, Edit, Write, or any other tool.
You have all context in the conversation above. The harness ignores tool calls.
Reply with the summary body only (no preamble).
Respond in the same language as the conversation.
Do not continue the task. Do not answer open questions. Only summarize.

Use exactly these 7 headings:

## 1. Goal
One or two lines on user intent. Primary request first.

## 2. Constraints (verbatim)
Copy user constraints and security rules word for word.
Never paraphrase this section.

## 3. Decisions
Each choice plus one-line reason. Drop superseded drafts.

## 4. Files and snippets
Exact paths touched plus one line per change.
Keep exact commands, IDs, error text still needed. Drop full logs.

## 5. Errors and fixes
What broke, what fixed it, and what the fix did not repair.

## 6. Pending tasks
What remains, next action first. Preserve any unanswered
user question or imperative request verbatim.

## 7. Next step
The single action the next session takes first.
