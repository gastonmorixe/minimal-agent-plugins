# ma-host-text-plugin

Holds host text for core errors. Core holds no text, so a host needs a renderer.

Today this package holds only the dev renderer. It has no user text yet.
For any error it prints the `kind` and the `fields` as JSON, for example
`InvariantError {"invariant":"x.y","data":{"a":1}}`.

Use `createDevErrorRenderer()` and register it with an `ErrorRendererRegistry`
under the owner id `ma-host-text-plugin`.
