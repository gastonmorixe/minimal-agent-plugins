# Cloud Connector

This plugin connects this session to the minimal-agent cloud backend. The plugin owns the network transport. It registers the transport in the host transport registry. Peers and teams of Intercom can then span machines without a change. The rest of the system never sees if a transport is local or remote.

Login is real. The CLI authenticates to the backend with the OAuth device grant (RFC 8628). The CLI stores a bearer token locally.

`cloudEnabled` is `false` until you log in. After login, the feature flags come from the backend (`me { flags }`). The network methods of the remote transport are still a stub until the WebSocket layer lands. The auth and the flags path is live.

## Tools

- `CloudLogin` - log in with the device grant. The tool prints a short user code and a verification URL. Approve the code in your browser. The tool completes the login and saves the token. The backend defaults to `http://localhost:4000/api/auth`. To change it, set `MINIMAL_AGENT_CLOUD_URL`.
- `CloudStatus` - show the login state, the feature flags, the backend URL, and the state of the remote transport. The call also registers the transport when it is not present. The call is idempotent.

## Config (env)

- `MINIMAL_AGENT_CLOUD_URL` - auth base URL (default `http://localhost:4000/api/auth`).
- `MINIMAL_AGENT_CLOUD_GRAPHQL_URL` - GraphQL endpoint (default: derived as the origin root `/graphql`).
- `MINIMAL_AGENT_CLOUD_CLIENT_ID` - device-grant client id (default `minimal-agent-cli`).
- `MINIMAL_AGENT_CLOUD_SCOPE` - requested scope (default `teleport remote-peers`).

The CLI stores the token at `~/.minimal-agent/cloud-auth.json`. Only the owner can read the file. The file is outside any repo.

## Architecture (why this plugin never imports Intercom or core)

The plugin hands its remote transport to Intercom through the host-brokered `transport:registry` capability. The plugin calls `host.transportRegistry.register(...)`. Intercom calls `list()`. Neither plugin imports the other.

The host is a neutral broker. The host treats a transport as opaque. The provider plugins use the same dependency-inversion shape to register models.
