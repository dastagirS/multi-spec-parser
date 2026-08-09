/**
 * The flagship use case: turn any API spec into LLM tool definitions.
 *
 * This is the shape most agent frameworks want — OpenAI-style function
 * calling. Each tool carries:
 *   - name/description from the spec's operationId + description
 *   - parameters = the tool's input JSON Schema with ONLY its reachable
 *     $ref closure ($defs) — Ajv-compilable, no multi-MB embedded schemas
 *   - outputSchema = the success-response contract, refs resolvable against
 *     inputSchema.$defs
 *
 * Run: node examples/llm-tools.mjs   (needs network)
 */
import { MultiSpecParser } from "multi-spec-parser";

const parser = new MultiSpecParser({
  spec: { url: "https://petstore3.swagger.io/api/v3/openapi.json" },
});
await parser.parse();

const tools = parser.tools();

// 1. OpenAI-style function definitions — drop-in for tool-calling APIs.
const openaiTools = tools.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.operation.description ?? tool.operation.summary ?? tool.name,
    parameters: tool.inputSchema,
  },
}));
console.log("tool count:", openaiTools.length);
console.log("sample definition:");
console.log(
  JSON.stringify(openaiTools.find((t) => t.function.name === "findPetsByStatus"), null, 2).slice(0, 700),
);

// 2. Memory story: per-tool closure vs the naive "embed every shared schema
//    into every tool" approach (the 4GB-OOM path this package exists to fix).
const wholeSpecBytes = JSON.stringify(parser.defs).length; // full shared schema map
const naiveBytes = tools.length * wholeSpecBytes; // embedded per tool
const closureBytes = tools.reduce((sum, t) => sum + JSON.stringify(t.inputSchema).length, 0);
console.log(
  `\nmemory: ${tools.length} tools × per-tool closure = ${(closureBytes / 1024).toFixed(0)}KB ` +
    `vs ~${(naiveBytes / 1024).toFixed(0)}KB if the full map (${(wholeSpecBytes / 1024).toFixed(0)}KB) ` +
    `were embedded in each tool (${(naiveBytes / Math.max(closureBytes, 1)).toFixed(0)}× less)`,
);

// 3. Output contract: the success-response schema. Its $refs resolve against
//    the same tool's inputSchema.$defs (shared closure, never duplicated).
console.log("\ngetPetById outputSchema:", JSON.stringify(parser.outputSchema("getPetById")));
console.log("refs resolve against inputSchema.$defs:", Object.keys(parser.tool("getPetById").inputSchema.$defs ?? {}));
