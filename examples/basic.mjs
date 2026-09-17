/**
 * Quick start: parse one API description into operation-level JSON Schemas.
 *
 * Run: node examples/basic.mjs
 * (In-repo this self-references the package; after `npm install
 * multi-spec-parser` consumers use the exact same import.)
 */
import { MultiSpecParser } from "multi-spec-parser";

const yaml = `
openapi: 3.0.3
info:
  title: Mini Pet API
  version: 1.0.0
servers:
  - url: https://api.example.com/v1
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
  /pets:
    post:
      operationId: createPet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/NewPet" }
      responses:
        "201":
          description: created
components:
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id: { type: integer, format: int64 }
        name: { type: string }
        tag: { type: string }
    NewPet:
      type: object
      required: [name]
      properties:
        name: { type: string }
        tag: { type: string }
`;

// Construct with JSON/YAML text or a pre-parsed object.
const parser = new MultiSpecParser({ spec: { text: yaml } });

const operations = await parser.parse();
console.log("format:", parser.format);
console.log("operations:", operations.length, "| baseUrl:", parser.baseUrl);

// Each operation carries only the definitions reachable from its input and
// output schemas. Compact projections replace over-budget closures with names.
for (const operation of await parser.parse({ compact: true, maxBytes: 4_000 })) {
  const inputBytes = new TextEncoder().encode(JSON.stringify(operation.inputSchema)).byteLength;
  console.log(
    `  ${operation.name.padEnd(10)} ${operation.method.padEnd(5)} ${operation.path} ` +
      `input=${inputBytes}B`,
  );
}

const getPet = await parser.operation("getPet");
console.log("getPet schema:", JSON.stringify(getPet?.inputSchema));
