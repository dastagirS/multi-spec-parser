# multi-spec-parser

Parse **OpenAPI 3.0/3.1**, **Swagger 2.0**, and **Google Discovery** documents
into one normalized collection of operation-level schema handles.

The package parses and projects API descriptions. It does not build HTTP
requests, execute operations, manage authentication, or run consumer workflows.

> ⚠️ **WIP — expect breaking changes.** This package is pre-1.0. Pin an exact
> version before upgrading.

## Why

- **One operation model:** all supported source formats produce the same shape.
- **Self-contained schemas:** each input and output handle carries only its
  reachable TypeScript definitions.
- **Bounded presentation:** generated TypeScript types have explicit depth,
  branch, node, property, and output-length limits.
- **Standard Schema:** operation schemas can be adapted to Standard Schema and
  Standard JSON Schema.
- **Memory safety:** eager parsing normalizes shared definitions once; lazy URL
  loading keeps the source on disk and materializes one operation closure at a
  time.

## Install

```sh
npm install multi-spec-parser
```

YAML is decoded by the bundled dependency-free Node-API addon. Installation uses
a matching prebuild when available and otherwise compiles the bundled C source.

## Quick start

```ts
import { MultiSpecParser } from "multi-spec-parser";

const parser = new MultiSpecParser({
  spec: {
    text: `
openapi: 3.0.3
info: { title: Pets, version: "1" }
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pet" }
components:
  schemas:
    Pet:
      type: object
      properties:
        id: { type: string }
`,
  },
});

const operations = await parser.parse();

console.log(parser.format); // openapi3
console.log(operations.length); // 1

const operation = await parser.getOperation("getPet");
console.log(operation?.method);       // GET
console.log(operation?.path);         // /pets/{petId}
console.log(operation?.input.type);   // TypeScript input presentation
console.log(operation?.output?.type); // TypeScript success-response presentation

const result = await operation?.input.validate({ petId: "123" });
console.log(result?.status); // ok or error
```

## How it works

```text
                         ┌─ OpenAPI 3 adapter ───────┐
source → bounded loader ─┼─ Swagger 2 adapter ───────┼→ normalized model
                         └─ Discovery adapter ───────┘         │
                                                               ▼
                                                    operation compiler
                                                               │
                                      ┌────────────────────────┴──────────┐
                                      ▼                                   ▼
                             operation schema handles           Standard Schema adapter
```

There are two loading paths:

- **Eager:** URL, text, or object → complete parsed document → every operation.
- **Lazy:** URL → bounded temporary file → structural byte-range index → one
  requested operation plus its transitive references.

Both paths use the same format adapters and operation compiler, so a materialized
lazy operation has the same shape as its eager counterpart. See
[`docs/architecture.md`](docs/architecture.md) and
[`docs/lazy-loading.md`](docs/lazy-loading.md).

## Sources

The parser accepts a URL, JSON/YAML text, or a pre-parsed object:

```ts
new MultiSpecParser({ spec: { url: "https://example.com/openapi.yaml" } });
new MultiSpecParser({ spec: { text: sourceText } });
new MultiSpecParser({ spec: { spec: sourceObject } });
```

| Source | Eager `parse()` | Lazy `load()` |
|---|---:|---:|
| HTTP(S) URL | Yes | Yes |
| Caller-owned text | Yes | No |
| Caller-owned object | Yes | No |

Text and object sources are intentionally eager because the complete source is
already resident in caller-owned memory.

URL loading accepts HTTP(S), enforces a 200 MiB response limit and a 60-second
timeout, and supports cancellation:

```ts
const operations = await parser.parse({ signal: abortController.signal });
```

For large URL sources, lazy mode streams the response to a bounded temporary
file, structurally indexes OpenAPI 3.x, Swagger 2.0, or Google Discovery JSON
(and OpenAPI 3.x block YAML), and materializes only requested operations and
their transitive schema references:

```ts
const parser = new MultiSpecParser({
  spec: { url: "https://example.com/openapi.yaml" },
  options: { lazy: true },
});

try {
  await parser.load({ signal: abortController.signal });
  console.log(parser.operationNames());
  const operation = await parser.getOperation("getPet");
} finally {
  await parser.close();
}
```

Lazy mode rejects text and object sources, unknown formats, and unsupported
layouts instead of falling back to eager parsing. `parse()` is unavailable in
lazy mode. `close()` is idempotent and removes the temporary file.

Authentication and custom request policy remain caller-owned. Fetch protected
sources first, then pass their text to the parser. Object sources remain
caller-owned and are not mutated.

## Operation projections

`parse()` returns a copy of the operation collection. Every operation has:

```ts
interface CompiledOperation {
  name: string;
  operationKey: string; // stable METHOD + path identity
  description: string;
  method: string;
  path: string;
  input: OperationSchema;
  output: OperationSchema | undefined;
  operation: ExtractedOperation;
  unresolvedRefs?: string[];
}
```

`name` comes from the source operation identifier, with deterministic fallback
and deduplication. `operationKey` remains independent of that generated name.

Each schema handle has exactly three public members:

```ts
interface OperationSchema {
  readonly type: string;
  readonly definitions: Readonly<Record<string, string>>;
  validate(value: unknown): Promise<ValidationResult>;
}
```

`type` is a bounded TypeScript presentation. `definitions` contains only named
types reachable from that input or output root. The canonical JSON Schema stays
private so consumers cannot accidentally couple workflows to the compiler's
intermediate representation.

Validation is dependency-free, does not mutate or coerce values, and never
inserts defaults. Expected outcomes use a discriminated result:

```ts
type ValidationResult =
  | { status: "ok"; value: unknown }
  | { status: "error"; error: ValidationError };
```

`ValidationError` is tagged as `ValidationFailed`,
`UnsupportedValidationKeyword`, or `ValidationLimitExceeded`. Unsupported
assertions reject instead of being silently ignored. Validation plans are
compiled lazily and memoized per handle.

## Standard Schema

After eager parsing, the parser can adapt an operation to Standard Schema and
Standard JSON Schema:

```ts
const schema = parser.toStandardSchema("getPet");

const validation = await schema.validate({ petId: "123" });
const input = schema.input("draft-07");
const output = schema.output(); // draft-2020-12 by default
```

Input and output projections independently include only definitions reachable
from their respective roots. The underlying `schema["~standard"]` property is
available for framework interoperability, but normal application code does not
need to access it. The adapter uses the same dependency-free validator as the operation handle.
A direct adapter is available from the subpath. This is also the lazy-mode
route: materialize the operation first, then pass the operation object.

```ts
import { toStandardSchema } from "multi-spec-parser/standard-schema";

const operation = await parser.getOperation("getPet");
const schema = toStandardSchema(operation!);
```

## Formats

| Format | Detection | Eager | Lazy URL | Notable normalization |
|---|---|---:|---:|---|
| OpenAPI 3.0.x | `openapi: "3.0.x"` | JSON/YAML | JSON/block YAML | `nullable` and boolean exclusive bounds |
| OpenAPI 3.1.x | `openapi: "3.1.x"` | JSON/YAML | JSON/block YAML | type arrays and numeric exclusive bounds |
| Swagger 2.0 | `swagger: "2.0"` | JSON/YAML | JSON | body/formData and `collectionFormat` conversion |
| Google Discovery | `kind: "discovery#restDescription"` | JSON/YAML | JSON | resources, repeated parameters, and global parameters |

Detection uses document content, not URLs or file extensions.

## Options

| Option | Default | Purpose |
|---|---:|---|
| `maxDefsBytes` | 1,000,000 | Use the shared definition map when an operation closure exceeds this UTF-8 budget |
| `lazy` | `false` | Index a supported JSON or OpenAPI block-YAML URL on disk and materialize operations on demand |

`parse()` accepts only an optional cancellation signal. Unknown options throw
immediately so removed functionality cannot silently
become a no-op.

## Examples and verification

```sh
npm run examples
npm test
npm run battle
```

- [`examples/basic.mjs`](examples/basic.mjs) demonstrates operation projection
  and schema handles.
- [`examples/multi-format.mjs`](examples/multi-format.mjs) demonstrates all
  supported source formats.
- [`docs/README.md`](docs/README.md) indexes the architecture and lifecycle
  documentation.
- [`docs/show-me-multi-spec-parser.html`](docs/show-me-multi-spec-parser.html)
  is a visual walkthrough of eager and lazy execution.

The battle suite checks large real and synthetic descriptions in bounded child
processes, including cyclic references, dense definition graphs, missing
references, and thousands of operations.

## License

MIT
