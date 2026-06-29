/**
 * KEYSTONE e2e — proves the whole decoupled architecture end-to-end, locally,
 * with no backend.
 *
 * The chain under test, three independently-owned pieces meeting only at the
 * host:
 *   1. CORE   — `buildPluginHost` grants the `transport:registry` capability
 *               (process-wide store).  [minimal-agent, WT-transport-registry branch]
 *   2. CLOUD  — `registerTransport(host)` registers a RemoteWsTransport stub.
 *               [this plugin]
 *   3. INTERCOM — `buildTransport(local, registry.list())` folds the registered
 *               remote transport into its CompositeTransport.
 *               [ma-intercom-plugin, a5-transport-port branch]
 *
 * The proof: a transport registered by the CLOUD plugin's host is visible to a
 * SEPARATE host that INTERCOM would hold, and Intercom's composite picks it up —
 * WITHOUT cloud importing intercom or core, and without intercom importing cloud.
 * Neither plugin's source references the other; they meet only through the
 * host-brokered registry.
 *
 * ## Cross-worktree note
 *
 * This is the "test environment that merges the two held branches" Steve asked
 * for. It imports the REAL core registry from the sibling core worktree
 * (`minimal-agent_WT-transport-registry`) and the REAL intercom transport from
 * the sibling plugin (`../ma-intercom-plugin`, a5). If the core worktree isn't
 * present, the suite skips with a clear message rather than failing — it is a
 * proof harness, not a CI unit test.
 *
 * @module e2e/registration.e2e.test
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { isTransportRegistered, registerTransport } from "../lib/register.ts"
import { RemoteWsTransport } from "../lib/transport.ts"

// Sibling worktree holding the core transport:registry capability.
const CORE_WT = join(import.meta.dir, "..", "..", "..", "minimal-agent_WT-transport-registry")
const CORE_FACTORY = join(CORE_WT, "src", "plugins", "host", "factory.ts")
const CORE_RESET = join(CORE_WT, "src", "plugins", "host", "transport-registry.ts")

// Sibling plugin (a5) holding Intercom's real Transport port + composite.
const INTERCOM_TRANSPORT = join(
  import.meta.dir,
  "..",
  "..",
  "ma-intercom-plugin",
  "lib",
  "transport.ts",
)

const haveCore = existsSync(CORE_FACTORY)
const haveIntercom = existsSync(INTERCOM_TRANSPORT)

describe("KEYSTONE: cloud plugin registers a transport that Intercom folds in (no cross-import)", () => {
  if (!haveCore || !haveIntercom) {
    it.skip(`skipped — need core WT (${haveCore}) + intercom a5 (${haveIntercom}) present`, () => {})
    return
  }

  // Pin MINIMAL_AGENT_HOME to an empty temp dir per test so the real
  // RemoteWsTransport.readPresence() / readInbox() (which read the
  // host-resolved presence/inbox dirs) do NOT pick up live records from
  // the dev box's `~/.minimal-agent/intercom/`. Without this the
  // composite folds real sessions into the assertion and the count
  // drifts machine-to-machine.
  let tmpHome: string
  let savedHome: string | undefined
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "cloud-keystone-e2e-"))
    savedHome = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = tmpHome
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it("end-to-end: register via cloud host → list via intercom host → composite folds it", async () => {
    // Real core registry + a reset helper to keep the process-wide store clean.
    const { buildPluginHost } = (await import(CORE_FACTORY)) as {
      buildPluginHost: (o: { capabilities: string[] }) => {
        transportRegistry?: { list(): { id: string }[] }
      }
    }
    const { __resetTransportRegistryForTests } = (await import(CORE_RESET)) as {
      __resetTransportRegistryForTests: () => void
    }
    // Real intercom transport composer.
    const intercom = (await import(INTERCOM_TRANSPORT)) as {
      buildTransport: (
        local: unknown,
        remotes?: readonly unknown[],
      ) => { id: string; remote: boolean; readPresence(): unknown[] }
      LocalFsTransport: new (io: unknown, sid: string) => unknown
    }

    __resetTransportRegistryForTests()

    // --- 1. CORE grants the capability to two SEPARATE plugin hosts. ---
    const cloudHost = buildPluginHost({ capabilities: ["transport:registry"] })
    const intercomHost = buildPluginHost({ capabilities: ["transport:registry"] })
    expect(cloudHost).not.toBe(intercomHost)
    expect(cloudHost.transportRegistry).toBeDefined()
    expect(intercomHost.transportRegistry).toBeDefined()

    // --- 2. CLOUD registers its remote transport into ITS host. ---
    const outcome = registerTransport(cloudHost as never)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.transportId).toBe("cloud-ws")

    // --- 3. INTERCOM, via its SEPARATE host, sees the cloud-registered transport. ---
    const remotes = intercomHost.transportRegistry?.list() ?? []
    expect(remotes.map((t) => t.id)).toContain("cloud-ws")

    // --- 4. INTERCOM folds it into its real CompositeTransport beside a local one. ---
    // A minimal local transport (no disk): satisfies the port structurally.
    const localPresence = [{ sid: "local-1", ts: "2026-06-24T00:00:00.000Z" }]
    const localStub = {
      id: "local-fs",
      remote: false,
      publishPresence() {},
      readPresence() {
        return localPresence
      },
      deliver() {},
      readInbox() {
        return []
      },
    }
    const composite = intercom.buildTransport(localStub, remotes)

    // The composite is remote-capable (a remote child is present) and merges
    // local + remote presence (remote stub returns []), so local survives.
    expect(composite.remote).toBe(true)
    expect(composite.readPresence().length).toBe(1)

    // Sanity: the cloud transport really is the stub we built.
    expect(remotes.find((t) => t.id === "cloud-ws")).toBeInstanceOf(RemoteWsTransport)

    __resetTransportRegistryForTests()
  })

  it("isTransportRegistered reflects register/unregister through the host", async () => {
    const { buildPluginHost } = (await import(CORE_FACTORY)) as {
      buildPluginHost: (o: { capabilities: string[] }) => {
        transportRegistry?: { unregister(id: string): void }
      }
    }
    const { __resetTransportRegistryForTests } = (await import(CORE_RESET)) as {
      __resetTransportRegistryForTests: () => void
    }
    __resetTransportRegistryForTests()

    const host = buildPluginHost({ capabilities: ["transport:registry"] })
    expect(isTransportRegistered(host as never)).toBe(false)
    registerTransport(host as never)
    expect(isTransportRegistered(host as never)).toBe(true)
    host.transportRegistry?.unregister("cloud-ws")
    expect(isTransportRegistered(host as never)).toBe(false)

    __resetTransportRegistryForTests()
  })
})

describe("cloud plugin unit: register degrades gracefully without the capability", () => {
  it("returns ok:false when the host lacks transportRegistry (older core / not granted)", () => {
    const out = registerTransport({ capabilities: [] } as never)
    expect(out.ok).toBe(false)
  })

  it("registers a custom transport via the injected factory (idempotent, last-write-wins)", () => {
    // A purely-local fake registry (no core needed) proves register()'s own logic.
    const store = new Map<string, { id: string }>()
    const host = {
      capabilities: ["transport:registry"],
      transportRegistry: {
        register: (t: { id: string }) => void store.set(t.id, t),
        unregister: (id: string) => void store.delete(id),
        list: () => [...store.values()],
      },
    }
    const first = registerTransport(host as never, () => new RemoteWsTransport({ id: "x" }))
    expect(first.ok && first.alreadyPresent).toBe(false)
    const second = registerTransport(host as never, () => new RemoteWsTransport({ id: "x" }))
    expect(second.ok && second.alreadyPresent).toBe(true)
    expect(store.size).toBe(1)
  })
})
