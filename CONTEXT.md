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

## Source Partitioning

Reducing source transfer is different from lazy operation materialization. The
parser does not infer provider-specific services or expose semantic operation
selectors. Callers that need a smaller workload provide a narrower upstream API
description, such as Microsoft Graph's workload-specific OpenAPI documents.
Within that source, `operationNames()` and `getOperation()` remain the lazy
access boundary.

## Operation Schema Handles

Canonical normalization remains JSON-Schema-based, but canonical JSON Schema is
private. Standard JSON Schema projections independently include only definitions
reachable from their input or output root.

`getOperation(name)` returns a compiled operation with an `input` schema handle
and optional `output` schema handle. Validation belongs to the selected handle,
not to the parser: consumers call `operation.input.validate(value)` or
`operation.output?.validate(value)`. There is no ambiguous `parser.validate()`
and no `defaultPolicy`; validation observes values without applying defaults or
other consumer-owned transformations.

The complete public handle surface is `type`, `definitions`, and `validate()`.
`type` is a bounded compact TypeScript preview; `definitions` keeps referenced
TypeScript declarations separate; and `validate()` lazily compiles and memoizes
validation against private canonical JSON Schema. TypeScript remains
presentation rather than the validation model.
Rendering degrades to `unknown` beyond safety limits. The dependency-free
validator is available only through parser-produced handles and rejects
unsupported assertion keywords rather than silently ignoring them. No custom
type AST or Zod schema API is planned.
