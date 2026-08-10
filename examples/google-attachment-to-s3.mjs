/**
 * Google attachment → S3, done consumer-side. The package's job ends at the
 * BYTES: parsing the Discovery doc, building/executing the Gmail request
 * (with YOUR token), handing you the decoded attachment. Everything after —
 * OAuth, S3 signing, the upload — is consumer code, on purpose.
 *
 *   parser (Gmail doc) → execute(attachments.get) → bytes → your S3 client
 *
 * Network-free: one local server plays both roles — the Google mock (serves
 * the attachment) and the S3 mock (captures the PUT).
 *
 * Run: node examples/google-attachment-to-s3.mjs
 */
import { createServer } from "node:http";
import { MultiSpecParser } from "multi-spec-parser";

// The Gmail Discovery doc, trimmed to the attachment endpoint. In production
// this comes from https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest.
const GMAIL_DISCOVERY = {
  kind: "discovery#restDescription",
  name: "gmail",
  version: "v1",
  title: "Gmail API",
  rootUrl: "https://gmail.googleapis.com/",
  servicePath: "",
  resources: {
    users: {
      resources: {
        messages: {
          resources: {
            attachments: {
              methods: {
                get: {
                  id: "gmail.users.messages.attachments.get",
                  path: "gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}",
                  httpMethod: "GET",
                  description: "Gets the specified message attachment.",
                  parameters: {
                    userId: { type: "string", location: "path", required: true },
                    messageId: { type: "string", location: "path", required: true },
                    id: { type: "string", location: "path", required: true },
                  },
                  response: { $ref: "MessagePartBody" },
                  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
                },
              },
            },
          },
        },
      },
    },
  },
  schemas: {
    MessagePartBody: {
      type: "object",
      properties: {
        size: { type: "integer", format: "int32" },
        data: { type: "string", format: "byte" }, // base64url
      },
    },
  },
};

const ATTACHMENT = Buffer.from("invoice #42 — total $128.50\r\n");
const BUCKET = "receipts";
const KEY = "2025/invoice-42.eml";
let s3Put = null; // { url, contentType, body } captured by the S3 mock

// 1. One local server, two personas. /gmail/v1/… is the Google mock;
//    PUT /receipts/… is the S3 mock. (S3-compatible stores accept path-style
//    PUTs; a real S3 also needs SigV4 — see putToS3 below.)
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/gmail/v1/")) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ size: ATTACHMENT.length, data: ATTACHMENT.toString("base64url") }),
    );
    return;
  }
  if (req.method === "PUT" && req.url.startsWith(`/${BUCKET}/`)) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      s3Put = { url: req.url, contentType: req.headers["content-type"], body: Buffer.concat(chunks) };
      res.statusCode = 200;
      res.setHeader("etag", '"mock-etag"');
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const parser = new MultiSpecParser({
  spec: { spec: GMAIL_DISCOVERY },
  options: { baseUrl: `http://127.0.0.1:${port}` },
});

// 2. parse() returns the RAW document, typed to the Discovery doc. You can
//    read anything the normalizer didn't model — here, the response schema
//    (format: "byte" = base64url) straight off the source.
const { schemas } = await parser.parse();
console.log("response schema:", JSON.stringify(schemas.MessagePartBody.properties.data));

const tool = parser.tool("gmail_users_messages_attachments_get");
console.log("tool:", tool.name, "→", tool.operation.method, tool.operation.path);

// 3. Execute the attachment GET. The OAuth token is YOURS — data, not
//    package logic (the package never learns OAuth exists).
const res = await parser.execute(tool, {
  userId: "me",
  messageId: "18b4f2c3d1e0a9f8",
  id: "ATTACH123",
}, { headers: { Authorization: "Bearer consumer-owned-token" } });

if (res.status !== "success") {
  console.error("Gmail fetch failed:", res.status, res.error);
  process.exit(1);
}

// 4. The package's job is done: raw bytes, decoded. (Gmail returns the
//    attachment body base64url-encoded.)
const bytes = Buffer.from(res.data.data, "base64url");
console.log(`attachment: ${bytes.length} bytes → ${JSON.stringify(bytes.toString())}`);

// 5. Consumer-owned S3 upload. Swap this for your SDK call / SigV4 signing
//    (aws4, @aws-sdk/client-s3, MinIO…) — that's your stack, not the
//    parser's. The parser never learned that S3 exists.
await putToS3(bytes, { bucket: BUCKET, key: KEY, port });

// 6. Proof: the S3 mock got the exact bytes.
console.log(`s3 put:      ${s3Put.url} (${s3Put.body.length} bytes)`);
console.log(`s3 body:     ${JSON.stringify(s3Put.body.toString())}`);
console.log("bytes match:", s3Put.body.equals(bytes));

await new Promise((resolve) => server.close(() => resolve()));

/** Minimal consumer-owned S3 PUT (path-style). No SDK, no signing — just the
 *  shape. Real S3 adds SigV4 headers (x-amz-date, Authorization:
 *  AWS4-HMAC-SHA256 …) — a ~40-line helper or your SDK of choice. */
function putToS3(body, { bucket, key, port }) {
  const url = `http://127.0.0.1:${port}/${bucket}/${key}`;
  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
}
