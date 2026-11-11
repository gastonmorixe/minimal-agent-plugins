Name the skill you activated in your reply.
Read bundled files with `Read`. Run bundled scripts with `Bash`.
Audit a skill from an untrusted source before you activate it. Read its SKILL.md and scan its scripts.
Do not store secrets in a SKILL.md or in its assets, because the whole body enters context on read.
When a skill declares the experimental `allowed-tools` field, the read result names it. Treat it as a soft contract and stay inside that set.
