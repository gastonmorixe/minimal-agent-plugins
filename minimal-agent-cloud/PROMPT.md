# Cloud Connector

This plugin connects this session to the minimal-agent cloud backend. It owns the network transport and registers it into the host transport registry, so Intercom's peers and teams can transparently span machines. Local-vs-remote is a transport detail the rest of the system never sees.

Login is real: the CLI authenticates to the backend with the OAuth device grant (RFC 8628) and stores a bearer token locally. `cloudEnabled` is `false` until you log in, then the feature flags come from the backend (`me { flags }`). The remote transport's network methods are still a stub until the WebSocket layer lands; the auth + flags path is live.

## Tools

- `CloudLogin` — log in via the device grant. Prints a short user code + a verification URL to approve in your browser, then completes login and saves the token. Backend defaults to `http://localhost:4000/api/auth`; override with `MINIMAL_AGENT_CLOUD_URL`.
- `CloudStatus` — report login state, feature flags, the backend URL, and whether the remote transport is registered. Calling it ensures the transport is registered (idempotent).

## Config (env)

- `MINIMAL_AGENT_CLOUD_URL` — auth base URL (default `http://localhost:4000/api/auth`).
- `MINIMAL_AGENT_CLOUD_GRAPHQL_URL` — GraphQL endpoint (default: derived as the origin root `/graphql`).
- `MINIMAL_AGENT_CLOUD_CLIENT_ID` — device-grant client id (default `minimal-agent-cli`).
- `MINIMAL_AGENT_CLOUD_SCOPE` — requested scope (default `teleport remote-peers`).

The token is stored at `~/.minimal-agent/cloud-auth.json` (owner-only, outside any repo).

## Architecture (why this plugin never imports Intercom or core)

The plugin hands its remote transport to Intercom through the host-brokered `transport:registry` capability: it calls `host.transportRegistry.register(...)`, Intercom calls `list()`. Neither plugin imports the other; the host is a neutral broker that treats a transport as opaque. This is the same dependency-inversion shape the provider plugins use to register models.
