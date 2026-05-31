#!/usr/bin/env bun

/**
 * Static preview of the ma-slash-menu overlay in a handful of states.
 *
 * Run: `bun run bin/preview.ts`
 *
 * Renders each canonical state (open, typing, scrolled, no-match, $)
 * with a small label, real skills loaded from disk, and ANSI colors.
 * Use this to visually verify the design without wiring into the host
 * REPL's editor.
 */

import type { CommandInfo } from "../lib/host-types.ts"
import { SGR } from "../lib/palette.ts"
import { renderOverlay } from "../lib/render.ts"
import { applySortMode, scoreItems } from "../lib/scoring.ts"
import type { Item, OverlayState, Trigger } from "../lib/types.ts"
import { commandItems } from "../providers/actions.ts"
import { defaultSkillsDeps, listSkills } from "../providers/skills.ts"

/**
 * Sample registered commands for the static preview. In the live plugin
 * these come from the host via `ctx.listCommands()`; here we hardcode a
 * representative set so the preview still shows `act` rows.
 */
const SAMPLE_COMMANDS: CommandInfo[] = [
  { name: "config", summary: "Edit minimal-agent settings interactively", pluginId: "config" },
  {
    name: "loop",
    summary: "Run a prompt on repeat while the session is open",
    pluginId: "schedule",
  },
  {
    name: "schedule",
    summary: "Schedule a prompt by cron, or list/cancel tasks",
    pluginId: "schedule",
  },
]

function gather(): Item[] {
  const actions = commandItems(SAMPLE_COMMANDS)
  const skills = listSkills(defaultSkillsDeps())
  return [...actions, ...skills]
}

function state(opts: {
  items: Item[]
  trigger: Trigger
  query: string
  selectedIndex?: number
  scrollOffset?: number
  cols?: number
  contextWindow?: number
}): OverlayState {
  // For "$" trigger, scope to skills only.
  const scoped = opts.trigger === "$" ? opts.items.filter((i) => i.category === "skl") : opts.items
  const scored = applySortMode(scoreItems(scoped, opts.query), "match-score")
  return {
    trigger: opts.trigger,
    query: opts.query,
    items: scored,
    selectedIndex: opts.selectedIndex ?? 0,
    scrollOffset: opts.scrollOffset ?? 0,
    maxRows: 5,
    cols: opts.cols ?? Math.min(process.stdout.columns ?? 100, 120),
    contextWindow: opts.contextWindow,
  }
}

function banner(title: string): string {
  const bar = "─".repeat(Math.max(0, 60 - title.length - 4))
  return `\n${SGR.boldSky}── ${title} ${bar}${SGR.reset}\n`
}

function fakeEditor(trigger: Trigger, query: string): string {
  return `${SGR.pink}❯ ${SGR.reset}${trigger}${query}${SGR.faintWhite}▏${SGR.reset}`
}

function paint(label: string, st: OverlayState): void {
  process.stdout.write(banner(label))
  for (const line of renderOverlay(st)) process.stdout.write(line + "\n")
  process.stdout.write("\n" + fakeEditor(st.trigger, st.query) + "\n")
}

function main(): void {
  const all = gather()

  paint(
    "State 1 — just opened (/, no query, top of list)",
    state({ items: all, trigger: "/", query: "" }),
  )

  paint(
    "State 2 — typing fuzzy-filters (/conf)",
    state({ items: all, trigger: "/", query: "conf" }),
  )

  paint(
    "State 3 — scrolled into skills (/swift, selection on 2nd match)",
    state({ items: all, trigger: "/", query: "swift", selectedIndex: 1 }),
  )

  paint("State 4 — no match (/zzzz)", state({ items: all, trigger: "/", query: "zzzz" }))

  paint(
    "State 5 — '$' forced activation, empty query",
    state({ items: all, trigger: "$", query: "", contextWindow: 1_000_000 }),
  )

  paint(
    "State 6 — '$' forced, filtered to swift skills",
    state({ items: all, trigger: "$", query: "swift", contextWindow: 1_000_000 }),
  )

  paint(
    "State 7 — narrow terminal (cols=70, badge drops)",
    state({ items: all, trigger: "/", query: "swift", cols: 70 }),
  )

  paint(
    "State 8 — very narrow (cols=50, only slug shows)",
    state({ items: all, trigger: "/", query: "swift", cols: 50 }),
  )

  process.stdout.write(
    `\n${SGR.dim}— end of preview. Discovered ${all.filter((i) => i.category === "skl").length} skills + ${all.filter((i) => i.category === "act").length} actions —${SGR.reset}\n`,
  )
}

main()
