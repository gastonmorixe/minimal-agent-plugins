# PHP syntax and Pint formatting

How `ma-diagnostics-plugin` checks PHP files after `Edit` / `Write`.

## What it detects

The plugin does not install PHP tools and does not pin PHP or Pint versions. It
spawns whatever the project already resolves.

| tool | kind | when it activates | how it runs |
| --- | --- | --- | --- |
| **php** | type | `php` on `PATH`, and a Composer/Laravel root signal (`composer.json` or `artisan`) | `php -l <file>` |
| **pint** | format | `vendor/bin/pint` (Composer) or `pint` on `PATH`, plus `pint.json` and/or a `laravel/pint` Composer dependency | `pint --test --format=json -v -- <file>` |

Pint always runs with `--test`. It never writes formatting changes to disk.
`-v` asks for richer reporter fields when that Pint build supports them.
`--` ends option parsing so odd paths stay file args.

Ad-hoc `.php` files outside a Composer root can still get `php -l` when `php` is
on `PATH` (fallback, same idea as sourcekit for Swift).

## When it runs

After a successful `Edit` or `Write` on a `.php` path, the hook runs the active
providers for that file. Findings land on the tool block and in the model note,
same as TypeScript / Biome.

## Config gates

`~/.minimal-agent/config.jsonc` under `plugins.diagnostics`:

- `type: true` (default): enables the php syntax provider
- `format: true` (default): enables the pint format provider
- `timeoutMs` (default `2000`): per-provider ceiling. Slow `php` or `pint` runs degrade instead of blocking the turn

Turn a gate off when you want silence for that kind. Disable the whole plugin
with `enabled: false` or `MINIMAL_AGENT_DIAGNOSTICS_DISABLED=1`.

## Binary resolution

- **php**: resolved from `PATH`
- **pint**: prefer `vendor/bin/pint` walking from the project root, then fall back to `PATH`

Providers run with `cwd` set to the project config root so project rules apply.
Host Docker / compose exec wrappers are out of scope for v1. Put `php` and
`vendor/bin` on the host PATH (or a worktree that already has them) for now.

## Exit codes

- `php -l`: exit 0 clean, non-zero syntax error (findings from stderr/stdout)
- `pint --test ...`: exit 0 clean, exit 1 style issues (findings from JSON). Exit 1 is a diagnostic hit, not a runner failure.

## Finding shapes

Syntax (`source: "php"`, `severity: "error"`, `code: "syntax"`):

```
Parse error: syntax error, unexpected token ";" in app/Models/User.php on line 12
```

Format (`source: "pint"`, `severity: "warning"`, `code: "format"`):

```
File does not match the project's formatting rules (reported by pint): ordered_imports, trailing_comma_in_multiline.
```

When verbose JSON includes a proposed diff, the finding appends a short
expected-content diff. When pint reports a mismatch with no fixer ids:

```
File does not match the project's formatting rules (reported by pint).
```

Messages never suggest a shell command. Fix the file with the project's own PHP
/ Pint setup.
