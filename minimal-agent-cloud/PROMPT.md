## minimal-agent cloud connector

This plugin connects this session to the minimal-agent cloud backend. It owns the
network transport and registers it into the host transport registry, so Intercom's
peers and teams can transparently span machines. Local-vs-remote is a transport
detail the rest of the system never sees.

Status: SKELETON. The remote transport is a stub (no live connection) until the
backend auth contract lands. `cloudEnabled` is `false` until you log in.

### Tool

- `CloudStatus` — report whether cloud features are enabled, the current feature
  flags, and whether the remote transport is registered. Calling it also ensures
  the (stub) remote transport is registered into the host registry (idempotent).

### Architecture (why this plugin never imports Intercom or core)

The plugin hands its remote transport to Intercom through the host-brokered
`transport:registry` capability: it calls `host.transportRegistry.register(...)`,
Intercom calls `list()`. Neither plugin imports the other; the host is a neutral
broker that treats a transport as opaque. This is the same dependency-inversion
shape the provider plugins use to register models.
