/**
 * `agent.willStop` broadcast handler — shut down the persistent obscura worker.
 *
 * The persistent worker is process-local and parent-bound via `exit`, but an
 * explicit willStop kill closes stdin / SIGKILLs immediately during graceful
 * lead teardown so we do not wait on process teardown ordering.
 *
 * @module ma-fetch/handlers/on_agent_will_stop
 */

import { shutdownPersistentWorker } from "../lib/persistent-worker.ts"

const handler = (): void => {
  shutdownPersistentWorker()
}

export default handler
