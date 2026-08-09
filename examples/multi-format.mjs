/**
 * The "multi-spec" claim: four formats, one class, one normalized model.
 * The spec source may be YAML/JSON text or a pre-parsed object.
 *
 * Run: node examples/multi-format.mjs
 */
import { MultiSpecParser } from "multi-spec-parser";

const specs = {
  "OpenAPI 3.0": `openapi: 3.0.3
info: { title: "Pets", version: "1" }
servers: [{ url: "https://api.example.com/v1" }]
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200": { description: ok }
`,

  "OpenAPI 3.1": `openapi: 3.1.0
info: { title: "Pets", version: "1" }
servers: [{ url: "https://api.example.com/v1" }]
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200": { description: ok }
`,

  "Swagger 2.0": {
    swagger: "2.0",
    info: { title: "Pets", version: "1" },
    host: "api.example.com",
    basePath: "/v1",
    schemes: ["https"],
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  },

  "Google Discovery": {
    kind: "discovery#restDescription",
    name: "mail",
    version: "v1",
    rootUrl: "https://mail.googleapis.com/",
    servicePath: "/v1/",
    resources: {
      users: {
        methods: {
          list: {
            id: "mail.users.messages.list",
            path: "users/{userId}/messages",
            flatPath: "users/{userId}/messages",
            httpMethod: "GET",
            parameters: {
              userId: { type: "string", location: "path", required: true },
              q: { type: "string", location: "query", repeated: true },
            },
            response: { $ref: "ListMessagesResponse" },
          },
        },
      },
    },
    schemas: {
      ListMessagesResponse: {
        id: "ListMessagesResponse",
        type: "object",
        properties: { messages: { type: "array", items: { $ref: "Message" } } },
      },
      Message: { id: "Message", type: "object", properties: { id: { type: "string" } } },
    },
  },
};

for (const [label, raw] of Object.entries(specs)) {
  const source = typeof raw === "string" ? { text: raw } : { spec: raw };
  const parser = new MultiSpecParser({ spec: source });
  await parser.parse();
  console.log(
    `${label.padEnd(18)} → ${parser.format.padEnd(8)} ${parser.tools().length} tool(s) | ` +
      `baseUrl: ${parser.baseUrl || "(none declared)"}`,
  );
}
