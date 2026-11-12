import { resolve } from "node:path"

import { expect, test } from "bun:test"

import { resolveEmbeddedRoots } from "./harness"

const PLUGINS_ROOT = resolve(import.meta.dir, "../..")
const paths = { root: "/r", cwd: "/r/cwd" }

test("resolveEmbeddedRoots returns only the plugins root by default", () => {
  expect(resolveEmbeddedRoots({}, paths)).toEqual([PLUGINS_ROOT])
})

test("resolveEmbeddedRoots appends extra roots", () => {
  const out = resolveEmbeddedRoots({ pluginRoots: (p) => [`${p.cwd}/x`] }, paths)
  expect(out).toEqual([PLUGINS_ROOT, "/r/cwd/x"])
})
