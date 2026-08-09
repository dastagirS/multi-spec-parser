/**
 * Build and execute HTTP requests from a real, live spec.
 *
 * Highlights:
 *  - One class: config → parse → tool lookup → build → execute.
 *  - options.baseUrl acts as the origin; petstore3's RELATIVE server (/api/v3)
 *    resolves against it.
 *  - options.headers become request defaults (auth); per-call ones merge in.
 *  - execute returns { status, httpStatus, data } — non-2xx is status:"error",
 *    never a thrown exception.
 *
 * Run: node examples/requests.mjs   (needs network)
 */
import { MultiSpecParser } from "multi-spec-parser";

const parser = new MultiSpecParser({
  spec: { url: "https://petstore3.swagger.io/api/v3/openapi.json" },
  options: {
    baseUrl: "https://petstore3.swagger.io", // origin; /api/v3 resolves against it
    headers: { Authorization: "Bearer YOUR_TOKEN" }, // integration-level auth
  },
});

await parser.parse();
console.log("compiled", parser.tools().length, "tools from", parser.format, "\n");

// Build only — no network. Query param comes from the tool's schema.
const req = parser.buildRequest("findPetsByStatus", { status: "available" });
console.log("GET ", req.method, req.url);
console.log("     headers:", JSON.stringify(req.headers));

// Execute — real fetch (Node 20+), JSON parsed automatically.
const res = await parser.execute("findPetsByStatus", { status: "available" });
console.log(
  "→",
  res.status,
  res.httpStatus,
  "| returned",
  Array.isArray(res.data) ? `${res.data.length} pets` : typeof res.data,
);

// POST bodies: JSON payloads nest under `body`; form-style fields are flat.
const createReq = parser.buildRequest("addPet", {
  body: { name: "Rex", photoUrls: ["https://example.com/rex.jpg"] },
});
console.log("\nPOST", createReq.method, createReq.url, "| body:", createReq.body);
console.log("(not executed — would create a pet on the live API)");
