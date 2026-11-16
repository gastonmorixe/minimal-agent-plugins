# ma-host-text-plugin

Holds host text for core errors. Core holds no text, so a host needs a renderer.

It holds 2 renderers:

- The boot renderer (`createBootErrorRenderer`): the user text for
  `ContractCheckFailedError`. It names each missing and duplicated contract.
- The dev renderer (`createDevErrorRenderer`). For any other error it prints the `kind` and the `fields` as JSON, for example
  `InvariantError {"invariant":"x.y","data":{"a":1}}`.

Use `createDevErrorRenderer()` and register it with an `ErrorRendererRegistry`
under the owner id `ma-host-text-plugin`.

The manifest declares this renderer in `errorRenderers`, so the plugin loader registers it in the host's registry by itself.
