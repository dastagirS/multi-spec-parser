# Domain Context

## Source Document

A complete OpenAPI 3.x, Swagger 2.0, or Google Discovery description supplied
as a URL, JSON/YAML text, or parsed object.

## Low-Memory Loading

Loading a large source document by indexing its operations and references
without materializing the complete parsed or normalized document. Operations
and their transitive schema references are materialized only when requested.
Caller-provided objects cannot satisfy this guarantee because the caller already
owns the complete object in memory. Low-memory loading is strict: unsupported
formats or layouts are rejected rather than silently materialized eagerly.
URL sources may be streamed into a bounded temporary file so operation and
component fragments remain seekable without retaining the full source in RAM.
A file-backed parser owns that temporary resource until idempotent `close()`;
failed loading cleans up automatically, and access after closing is invalid.
Low-memory URL loading must support JSON sources for all three canonical
formats: OpenAPI 3.x, Swagger 2.0, and Google Discovery. OpenAPI 3.x block YAML
also remains supported. Dedicated format indexers may be added incrementally,
but unsupported encodings or layouts reject until they have a bounded indexer;
they never fall back to eager parsing. Caller-owned text and object sources
remain eager. Consumers opt into low-memory loading with `options.lazy: true`;
omitted or false retains eager loading.

## Schema Presentation

Canonical normalization remains JSON-Schema-based internally. Consumers receive
compact TypeScript preview strings for operation input and output, with referenced
type definitions kept separately rather than repeatedly inlined. Validation is
lazy and memoized against the private canonical JSON Schema; TypeScript previews
are presentation, not the validation model. Rendering is bounded and degrades to
`unknown` when a schema exceeds its safety limits. Validation is dependency-free
and is available only through operation input/output handles produced by this
parser; there is no arbitrary-schema validation API. Unsupported assertion
keywords reject explicitly rather than being ignored. The package does not expose
a custom type AST, Ajv, or Zod schemas.
