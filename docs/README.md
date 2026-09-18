# multi-spec-parser documentation

`multi-spec-parser` turns OpenAPI 3.x, Swagger 2.0, and Google Discovery source
documents into one operation-level projection model.

## Guides

- [Architecture](architecture.md) — modules, eager flow, lazy flow, and schema closure.
- [Lazy loading](lazy-loading.md) — support matrix, lifecycle, limits, cleanup, and rejection behavior.
- [Visual walkthrough](show-me-multi-spec-parser.html) — side-by-side eager and lazy diagrams.

## Public API at a glance

```ts
const parser = new MultiSpecParser({ spec, options });

// Eager sources
const operations = await parser.parse();

// Lazy URL sources
await parser.load();
const names = parser.operationNames();
const operation = await parser.getOperation(names[0]);
await parser.close();
```

The package stops at parsing, normalization, schema projection, and validation.
It does not construct or execute API requests, manage authentication, process
responses, or inject consumer-owned fields.

## Canonical output

The current public unit is `CompiledOperation`:

```ts
interface CompiledOperation {
  name: string;
  operationKey: string;
  description: string;
  method: string;
  path: string;
  input: OperationSchema;
  output?: OperationSchema;
  operation: ExtractedOperation;
  unresolvedRefs?: string[];
}
```

`operationKey` is stable method-plus-path identity. `name` is generated from the
source operation identifier, with deterministic fallback and deduplication.
Each `OperationSchema` exposes only `type`, `definitions`, and asynchronous
`validate(value)`.
