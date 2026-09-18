# Architecture

## Pipeline

```text
Source
├── { url }   ── bounded HTTP loader
├── { text }  ── caller-owned text
└── { spec }  ── caller-owned object
       │
       ├── eager ── parse complete document
       │             │
       │             ▼
       │       detectSpecFormat
       │             │
       │     ┌───────┼──────────────┐
       │     ▼       ▼              ▼
       │  OpenAPI  Swagger 2  Google Discovery
       │     └───────┼──────────────┘
       │             ▼
       │       ParsedSpec model
       │             ▼
       │  compileSpecToOperations
       │
       └── lazy ── temporary file ── structural index
                                      │
                              operation(name)
                                      │
                              read byte ranges
                                      │
                         minimal source fragment
                                      │
                         same adapters + compiler
```

The eager and lazy paths converge before normalization. Lazy loading does not
maintain a second operation model.

## Module responsibilities

```text
src/
├── multi-spec-parser.ts          # public lifecycle and eager/lazy coordination
├── source-loader.ts              # bounded HTTP loading and temporary files
├── lazy-source-index.ts          # OpenAPI block-YAML index and JSON dispatch
├── lazy-json-source-index.ts     # bounded JSON scanner and format indexers
├── parse-spec.ts                 # format detection and normalization adapters
├── operation-compiler.ts         # operation names and schema-handle projection
├── operation-schema.ts           # public handle and private canonical schema
├── schema-type-renderer.ts       # bounded TypeScript presentation
├── schema-validator.ts           # bounded dependency-free validation
├── schema-closure.ts             # reference normalization and reachable defs
├── standard-schema-adapter.ts    # parser-bound Standard Schema interface
├── standard-schema.ts            # direct operation adapter
├── yaml-parser.ts                # native YAML boundary
└── types.ts                      # source and normalized model types
```

## Normalized operation boundary

Every format adapter produces `ParsedSpec`, containing normalized operations,
schemas, servers, and source format. The compiler then:

1. Normalizes schema references to `#/$defs/...`.
2. Prunes dangling references while recording them.
3. Derives deterministic operation names.
4. Builds input schemas from parameters and request bodies.
5. Selects success-response output schemas.
6. Creates separate input and output handles with their own transitive
   definition closures.

Canonical JSON Schema is retained privately. Public handles expose bounded
TypeScript text, referenced definitions, and explicit validation.

## Eager flow

```text
parse()
  load URL text, or use caller text/object
  parse JSON or YAML
  detect source format
  normalize the complete source
  compile every operation
  memoize the compile result
  return a copy of the operation array
```

Object sources remain caller-owned and are not mutated.

## Lazy flow

```text
load()
  stream URL response to bounded temporary file
  detect JSON versus block YAML by content
  scan structure and record byte ranges
  build deterministic operation-name index

getOperation(name)
  locate operation byte range
  read operation and metadata fragments
  follow transitive local references
  construct a minimal source document
  run the normal adapter and compiler
  memoize the compiled operation

close()
  close source file
  delete temporary directory
```

This avoids retaining source text, a complete parsed document, a complete
normalized model, and all compiled operations at the same time.

## Standard Schema

`parser.toStandardSchema(name)` adapts an eagerly compiled operation. In lazy
mode, materialize the operation first and use the direct adapter:

```ts
import { toStandardSchema } from "multi-spec-parser/standard-schema";

const operation = await parser.getOperation("getPet");
const schema = toStandardSchema(operation!);

await schema.validate({ petId: "123" });
schema.input("draft-07");
schema.output();
```

Input and output Standard JSON Schema projections independently include only
definitions reachable from their respective root. Runtime validation uses the
same bounded, dependency-free validation plan as each operation handle.
