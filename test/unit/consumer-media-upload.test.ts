/**
 * Consumer-side Google media upload — the proof that the parser + generic
 * primitives are enough: parser.parse() returns the RAW document (typed),
 * parser.buildRequest(…, { path }) builds on the upload path, and the
 * consumer owns the protocol (uploadType, bytes, framing, fetch). Zero
 * media-upload code exists in the package.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";

const DISCOVERY = {
  kind: "discovery#restDescription",
  name: "mail",
  version: "v1",
  title: "Mail API",
  description: "A tiny Gmail-like API.",
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
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
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

interface Captured {
  method: string;
  url: string;
  contentType: string | undefined;
  body: Buffer;
}

async function withServer(
  fn: (port: number, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("consumer-side media upload (parser + primitives only)", () => {
  it("parse() returns the typed raw document — the consumer reads the upload path from it", async () => {
    const parser = new MultiSpecParser({ spec: { spec: DISCOVERY } });
    const document = await parser.parse();
    assert.equal(document, DISCOVERY, "object source: same reference, typed");
    const uploadPath = document.resources.users.methods.send
      .mediaUpload!.protocols.simple.path;
    assert.ok(uploadPath.includes("/upload/mail/v1/"));
  });

  it("uploadType=media: path override + consumer bytes hit the wire byte-exact", async () => {
    await withServer(async (port, captured) => {
      const parser = new MultiSpecParser({
        spec: { spec: DISCOVERY },
        options: { baseUrl: `http://127.0.0.1:${port}` },
      });
      const { resources } = await parser.parse();
      const tool = parser.tool("mail_users_messages_send")!;
      const uploadPath = resources.users.methods.send
        .mediaUpload!.protocols.simple.path;

      const req = parser.buildRequest(tool, { userId: "me" }, { path: uploadPath });
      req.url += (req.url.includes("?") ? "&" : "?") + "uploadType=media";
      const raw = Buffer.from("From: a@b.c\r\nSubject: hi\r\n\r\nbody");
      req.body = raw;
      req.headers["Content-Type"] = "application/octet-stream";
      await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: toBodyInit(req.body),
      });

      assert.equal(captured.length, 1);
      const c = captured[0]!;
      assert.equal(c.method, "POST");
      assert.ok(c.url.includes("/upload/mail/v1/users/me/messages/send"), c.url);
      assert.ok(c.url.includes("uploadType=media"), c.url);
      assert.equal(c.body.toString(), raw.toString(), "raw bytes on the wire");
      assert.equal(c.contentType, "application/octet-stream");
    });
  });

  it("uploadType=multipart: consumer-owned framing with metadata + media parts", async () => {
    await withServer(async (port, captured) => {
      const parser = new MultiSpecParser({
        spec: { spec: DISCOVERY },
        options: { baseUrl: `http://127.0.0.1:${port}` },
      });
      const { resources } = await parser.parse();
      const tool = parser.tool("mail_users_messages_send")!;
      const uploadPath = resources.users.methods.send
        .mediaUpload!.protocols.simple.path;

      const req = parser.buildRequest(tool, { userId: "me" }, { path: uploadPath });
      req.url += (req.url.includes("?") ? "&" : "?") + "uploadType=multipart";
      const framed = buildMultipartRelated(
        { labelIds: ["SENT"] },
        Buffer.from("raw mime bytes"),
        "message/rfc822",
      );
      req.body = framed.body;
      req.headers["Content-Type"] = framed.contentType;
      await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: toBodyInit(req.body),
      });

      const c = captured[0]!;
      assert.ok(c.url.includes("uploadType=multipart"), c.url);
      assert.ok(c.contentType?.startsWith("multipart/related"), c.contentType);
      const boundary = c.contentType!.split("boundary=")[1]!;
      const text = c.body.toString("latin1");
      assert.ok(text.includes('"labelIds":["SENT"]'), "metadata part present");
      assert.ok(text.includes("raw mime bytes"), "media part present");
      assert.ok(text.includes(`--${boundary}--`), "closing boundary present");
    });
  });

  it("regular path is untouched without the override", async () => {
    await withServer(async (port, captured) => {
      const parser = new MultiSpecParser({
        spec: { spec: DISCOVERY },
        options: { baseUrl: `http://127.0.0.1:${port}` },
      });
      await parser.parse();
      const req = parser.buildRequest("mail_users_messages_send", {
        userId: "me",
        body: { raw: "abc" },
      });
      assert.ok(req.url.includes("/users/me/messages/send"), req.url);
      assert.ok(!req.url.includes("uploadType"), "no upload query by default");
      assert.equal(req.headers["Content-Type"], "application/json");
      assert.equal(req.body, '{"raw":"abc"}');
    });
  });
});

/** fetch() rejects Uint8Array<ArrayBufferLike> (Buffer) — hand fetch an
 *  ArrayBuffer copy, same trick the package's executor uses. */
function toBodyInit(body: string | FormData | Uint8Array | undefined): BodyInit | undefined {
  if (body === undefined || typeof body === "string" || body instanceof FormData) {
    return body;
  }
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

/** Consumer-owned multipart/related framing (Google protocol, their code —
 *  FormData can't produce anonymous related parts). */
function buildMultipartRelated(
  metadata: unknown,
  media: Buffer,
  mediaType: string,
): { body: Uint8Array; contentType: string } {
  const boundary = `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mediaType}\r\n` +
      `Content-Transfer-Encoding: binary\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + media.length + tail.length);
  body.set(head, 0);
  body.set(media, head.length);
  body.set(tail, head.length + media.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}
