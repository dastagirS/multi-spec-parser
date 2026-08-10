/**
 * Quick start: one class owns the whole lifecycle — config → parse → tools.
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

// Construct with the spec source — url, text, or a pre-parsed object.
// (text is JSON or YAML; content is sniffed, never the file extension.)
const parser = new MultiSpecParser({ spec: { text: yaml } });

// Load + parse (idempotent — repeated calls return the cached model).
// parse() returns the RAW document, typed to the input spec; the compiled
// tools + model live on the parser.
await parser.parse();
console.log("format:", parser.format);
console.log("operations:", parser.tools().length, "| baseUrl:", parser.baseUrl);

// Memory-safe tool definitions: each tool's schema carries only its own
// reachable $ref closure as $defs, not the whole spec.
const tools = parser.tools();
for (const tool of tools) {
  const inputBytes = JSON.stringify(tool.inputSchema).length;
  const defsBytes = JSON.stringify(tool.inputSchema.$defs ?? {}).length;
  console.log(
    `  ${tool.name.padEnd(10)} input=${String(inputBytes).padStart(4)}B ` +
      `defs=${String(defsBytes).padStart(4)}B  (shared map: ${Object.keys(parser.defs).length} schemas)`,
  );
}

// Look up a tool by name; build a request; execute.
const req = parser.buildRequest("getPet", { petId: "42" });
console.log("request:", req.method, req.url);
