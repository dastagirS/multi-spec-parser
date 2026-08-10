/**
 * Consumer-side Google media upload — the parser + primitives only.
 *
 * parse() returns the RAW parsed document (typed to the input spec), so the
 * consumer reads the upload path straight off Google's Discovery doc.
 * buildRequest(tool, args, { path }) builds on that path with placeholders
 * substituted. Everything Google-protocol (uploadType, raw bytes, framing,
 * fetch) is consumer code — the package never learns that uploadType exists.
 *
 * Network-free: a tiny local HTTP server captures what would hit Gmail.
 *
 * Run: node examples/consumer-media-upload.mjs
 */
import { createServer } from "node:http";
import { MultiSpecParser } from "multi-spec-parser";

const DISCOVERY = {
  kind: "discovery#restDescription",
  name: "mail",
  version: "v1",
  title: "Mail API",
  rootUrl: "https://mail.googleapis.com/",
  servicePath: "mail/v1/",
  resources: {
    users: {
      methods: {
        send: {
          id: "mail.users.messages.send",
          path: "users/{userId}/messages/send",
          httpMethod: "POST",
          description: "Send a message.",
          request: { $ref: "Message" },
          response: { $ref: "Message" },
          supportsMediaUpload: true,
          mediaUpload: {
            accept: ["message/rfc822"],
            protocols: {
              simple: { multipart: true, path: "/upload/mail/v1/users/{userId}/messages/send" },
            },
          },
        },
      },
    },
  },
  schemas: {
    Message: { type: "object", properties: { raw: { type: "string" } } },
  },
};

// 1. Local stand-in API: capture what hits the wire.
const captured = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured.push({
      method: req.method,
      url: req.url,
      contentType: req.headers["content-type"],
      body: Buffer.concat(chunks),
    });
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const parser = new MultiSpecParser({
  spec: { spec: DISCOVERY },
  options: { baseUrl: `http://127.0.0.1:${port}` },
});

// 2. parse() returns the raw document, TYPED to the input spec.
const { resources } = await parser.parse();
const tool = parser.tool("mail_users_messages_send");
const uploadPath = resources.users.methods.send.mediaUpload.protocols.simple.path;

// 3. Generic primitive: build on the upload path — placeholders resolve from
//    the same params as the regular op.
const req = parser.buildRequest(tool, { userId: "me" }, { path: uploadPath });

// 4. Google protocol, applied by the consumer (3 lines).
req.url += (req.url.includes("?") ? "&" : "?") + "uploadType=media";
req.body = Buffer.from("From: a@b.c\r\nSubject: hi\r\n\r\nbody"); // their bytes
req.headers["Content-Type"] = "application/octet-stream";

// 5. Their executor.
await fetch(req.url, { method: req.method, headers: req.headers, body: toBodyInit(req.body) });

const c = captured[0];
console.log("url:        ", c.url);
console.log("content-type:", c.contentType);
console.log("body bytes:  ", c.body.length, "→", JSON.stringify(c.body.toString()));
console.log("uploadPath came from the typed document:", uploadPath);

await new Promise((resolve) => server.close(() => resolve()));

// fetch() rejects Uint8Array<ArrayBufferLike> — hand an ArrayBuffer copy.
function toBodyInit(body) {
  if (typeof body === "string" || body instanceof FormData) return body;
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}
