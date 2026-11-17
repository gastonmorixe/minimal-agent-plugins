Tell the user the name of the skill that you activated. Read the files of a skill with `Read`. Run the scripts of a skill with `Bash`.

Before you activate a skill from a source that is possibly not safe, examine it. Read its SKILL.md file and examine its scripts.

Do not keep secrets in a SKILL.md file or in its other files. When you read a skill, its full body goes into the context.

A skill can have the `allowed-tools` field, which is not a stable part of the skill format. If the skill has this field, the `read` result gives it. Then use only the tools in that set. The harness does not stop the other tools.
