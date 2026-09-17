# multi-spec-parser

Parse **OpenAPI 3.0/3.1**, **Swagger 2.0**, and **Google Discovery** documents
into one normalized collection of operation-level JSON Schemas.

The package parses and projects API descriptions. It does not build HTTP
requests, execute operations, manage authentication, or run consumer workflows.

> ⚠️ **WIP — expect breaking changes.** This package is pre-1.0. Pin an exact
> version before upgrading.

## Why

- **One operation model:** all supported source formats produce the same shape.
- **Self-contained schemas:** each operation carries the definitions reachable
  from its input and output schemas.
- **Bounded projections:** compact mode removes over-budget definition closures
  while preserving their reachable definition names.
- **Standard Schema:** operation schemas can be adapted to Standard Schema and
  Standard JSON Schema.
- **Memory safety:** shared definitions are normalized once instead of cloning
  every source definition into every operation.

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

const operation = await parser.operation("getPet");
console.log(operation?.method);       // GET
console.log(operation?.path);         // /pets/{petId}
console.log(operation?.inputSchema);  // JSON Schema
console.log(operation?.outputSchema); // JSON Schema for the success response
```

## Sources

The parser accepts a URL, JSON/YAML text, or a pre-parsed object:

```ts
new MultiSpecParser({ spec: { url: "https://example.com/openapi.yaml" } });
new MultiSpecParser({ spec: { text: sourceText } });
new MultiSpecParser({ spec: { spec: sourceObject } });
```

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
  const operation = await parser.operation("getPet");
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
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | undefined;
  operation: ExtractedOperation;
  unresolvedRefs?: string[];
}
```

`name` comes from the source operation identifier, with deterministic fallback
and deduplication. `operationKey` remains independent of that generated name.

Canonical input schemas retain the combined definition closure needed by their
input and output roots. This keeps output references resolvable against
`inputSchema.$defs`.

## Compact projections

Use compact mode when serialized schemas must fit a programmatic budget:

```ts
const compact = await parser.parse({
  compact: true,
  maxBytes: 32_000,
});
```

When a schema exceeds `maxBytes`, its `$defs` are replaced by `$refs`, an array
of reachable definition names. Canonical operations remain unchanged.

The budget is measured using serialized UTF-8 bytes. The default compact budget
is 64 KiB.

## Standard Schema

The parser can adapt an operation to Standard Schema and Standard JSON Schema:

```ts
const schema = parser.toStandardSchema("getPet");

const validation = await schema.validate({ petId: "123" });
const input = schema.input("draft-07");
const output = schema.output(); // draft-2020-12 by default
```

Input and output projections independently include only definitions reachable
from their respective roots. The underlying `schema["~standard"]` property is
available for framework interoperability, but normal application code does not
need to access it. Validation uses the optional dependencies `ajv` and
`ajv-formats`.

A synchronous adapter is available from the subpath:

```ts
import { toStandardSchema } from "multi-spec-parser/standard-schema";

const schema = toStandardSchema((await parser.operation("getPet"))!);
```

## Formats

| Format | Detection | Notable normalization |
|---|---|---|
| OpenAPI 3.0.x | `openapi: "3.0.x"` | `nullable` and boolean exclusive bounds |
| OpenAPI 3.1.x | `openapi: "3.1.x"` | type arrays and numeric exclusive bounds |
| Swagger 2.0 | `swagger: "2.0"` | body/formData and `collectionFormat` conversion |
| Google Discovery | `kind: "discovery#restDescription"` | resources, repeated parameters, and global parameters |

Detection uses document content, not URLs or file extensions.

## Options

| Option | Default | Purpose |
|---|---:|---|
| `maxDefsBytes` | 1,000,000 | Use the shared definition map when an operation closure exceeds this UTF-8 budget |
| `lazy` | `false` | Index a supported JSON or OpenAPI block-YAML URL on disk and materialize operations on demand |

Projection options passed to `parse()`:

| Option | Default | Purpose |
|---|---:|---|
| `compact` | `false` | Enable bounded schema projections |
| `maxBytes` | 65,536 | Per-schema serialized UTF-8 budget |

Unknown options throw immediately so removed functionality cannot silently
become a no-op.

## Examples and verification

```sh
npm run examples
npm test
npm run battle
```

- [`examples/basic.mjs`](examples/basic.mjs) demonstrates operation projection
  and compact schemas.
- [`examples/multi-format.mjs`](examples/multi-format.mjs) demonstrates all
  supported source formats.

The battle suite checks large real and synthetic descriptions in bounded child
processes, including cyclic references, dense definition graphs, missing
references, and thousands of operations.

## License

MIT
