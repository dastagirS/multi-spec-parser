/**
 * The 0.2.0 policy surface, end to end: filterOps, extraParameters, the
 * execute() pipeline (401 retry → processors → truncation), describeTools(),
 * validate(), and the Standard Schema adapter.
 *
 * Network-free: a tiny local HTTP server stands in for the API — it 401s once
 * (to trigger the auth retry), then returns a deliberately oversized body (to
 * trigger truncation).
 *
 * Run: node examples/policies.mjs
 */
import { createServer } from "node:http";
import { MultiSpecParser } from "multi-spec-parser";
import { toStandardSchema } from "multi-spec-parser/standard-schema";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Pets", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
    },
    "/pets": {
      get: {
        operationId: "listPets",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/NewPet" } },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
      NewPet: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    },
  },
};

// 1. Stand-in API: the first request 401s (auth refresh demo); every request
//    after that returns a body far larger than our truncation budget.
let calls = 0;
const server = createServer((req, res) => {
  calls += 1;
  if (calls === 1) {
    res.statusCode = 401;
    res.end("expired token");
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      items: Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        name: `pet-${i}`,
        blob: "x".repeat(20),
      })),
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// 2. Configure the whole policy surface. Everything stack-specific (token
//    refresh, logging) lives in these closures — the package never sees it.
const parser = new MultiSpecParser({
  spec: { spec: SPEC },
  options: {
    baseUrl: `http://127.0.0.1:${port}`,

    // filterOps: return true to keep. Read-only is one predicate on the HTTP
    // method; a denylist is just another predicate.
    filterOps: (op) => !["POST", "PUT", "PATCH", "DELETE"].includes(op.method), // keeps getPet + listPets, drops createPet

    // extraParameters: LLM-visible inputs that buildRequest ignores —
    // metadata only your processor cares about.
    extraParameters: {
      getPet: [
        { name: "traceId", schema: { type: "string" }, description: "Propagate a trace id." },
      ],
    },

    // 401 → onUnauthorized() → retry once (maxAuthRetries).
    onUnauthorized: async () => "Bearer fresh-token",
    maxAuthRetries: 1,

    // Uniform result-size guarantee, applied AFTER processors.
    maxResponseBytes: 2_000,
    onTruncate: (size, toolName) =>
      console.log(`  ⚠ onTruncate: ${toolName} was ${size} bytes`),

    // Per-tool response shaping (S3 upload, PII strip, …).
    processors: {
      listPets: async (result) => {
        if (result.status !== "success") return result;
        const count = Array.isArray(result.data?.items) ? result.data.items.length : 0;
        return { status: "success", data: { count }, httpStatus: 200 };
      },
    },

    // describeTools() budget for the LLM/prompt projection.
    describeMaxBytes: 200,
  },
});

await parser.parse();

// 3. filterOps: createPet never became a tool — can't be listed or executed.
console.log("filterOps → tools:", parser.tools().map((t) => t.name).join(", "));
try {
  await parser.execute("createPet", { body: { name: "x" } });
} catch (err) {
  console.log("  execute('createPet') →", err.message);
}

// 4. extraParameters: visible to the LLM, ignored by buildRequest.
const getPet = parser.tool("getPet");
console.log("extraParameters in inputSchema:", Object.keys(getPet.inputSchema.properties).join(", "));
console.log("buildRequest ignores extras:", parser.buildRequest("getPet", { petId: "1", traceId: "abc" }).url);

// 5. validate(): real Ajv check, never throws.
console.log("validate() bad args:", JSON.stringify(await parser.validate("getPet", {})));
console.log("validate() good args:", JSON.stringify(await parser.validate("getPet", { petId: "1" })));

// 6. execute() pipeline: getPet hits the 401 → refresh → retry → oversized
//    body → truncated. listPets runs its processor (shrinks → no truncation).
const truncated = await parser.execute("getPet", { petId: "1" });
console.log("execute(getPet):", truncated.status, truncated.size !== undefined ? `size=${truncated.size}` : "");
const processed = await parser.execute("listPets", {});
console.log("execute(listPets):", processed.status, JSON.stringify(processed.data));

// 7. describeTools(): the bounded LLM projection (with outputSchema).
const described = parser.describeTools().find((d) => d.name === "getPet");
console.log(
  "describeTools(getPet): $refs =",
  JSON.stringify(described.inputSchema.$refs),
  "| outputSchema present:",
  described.outputSchema !== undefined,
);

// 8. Standard Schema adapter — drop-in for Mastra/Zod/Valibot/ArkType.
const std = toStandardSchema(getPet);
console.log(
  "toStandardSchema:",
  std["~standard"].vendor,
  JSON.stringify(std["~standard"].validate({ petId: "1", traceId: "abc" })),
);

await new Promise((resolve) => server.close(() => resolve()));
console.log("\ndone.");
