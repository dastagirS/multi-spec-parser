/**
 * Item 9: Google Discovery media upload — the simple path (uploadType=media)
 * and multipart (uploadType=multipart) against a live local server, plus the
 * media-upload surface on the compiled tool and its input schema.
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
          description: "Send a message (supports media upload).",
          request: { $ref: "Message" },
          response: { $ref: "Message" },
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
          supportsMediaUpload: true,
          mediaUpload: {
            accept: ["message/rfc822"],
            protocols: {
              simple: { multipart: true, path: "/upload/mail/v1/users/{userId}/messages/send" },
              resumable: { multipart: true, path: "/resumable/upload/mail/v1/users/{userId}/messages/send" },
            },
          },
        },
        get: {
          id: "mail.users.messages.get",
          path: "users/{userId}/messages/{id}",
          httpMethod: "GET",
          description: "Get a message.",
          parameters: {
            id: { type: "string", location: "path", required: true },
          },
          response: { $ref: "Message" },
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      },
    },
  },
  schemas: {
    Message: {
      type: "object",
      id: "Message",
      properties: { id: { type: "string" }, raw: { type: "string" } },
    },
  },
};

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

async function withServer(
  capture: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
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
        headers: { ...req.headers } as Record<string, string | undefined>,
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

function makeParser(port: number): MultiSpecParser {
  return new MultiSpecParser({
    spec: { spec: DISCOVERY },
    options: { baseUrl: `http://127.0.0.1:${port}` },
  });
}

describe("google media upload (item 9)", () => {
  it("surfaces mediaUpload on the compiled tool", async () => {
    await withServer((req, res) => res.end("{}"), async (port) => {
      const parser = makeParser(port);
      await parser.parse();
      const send = parser.tool("mail_users_messages_send")!;
      assert.equal(send.method, "POST");
      assert.equal(send.mediaUpload?.uploadType, "media");
      assert.ok(send.mediaUpload?.simplePath?.includes("/upload/mail/v1/"));
      assert.deepEqual(send.mediaUpload?.accept, ["message/rfc822"]);
      const get = parser.tool("mail_users_messages_get")!;
      assert.equal(get.mediaUpload, undefined);
    });
  });

  it("advertises contentType + bodyBase64 inputs on media-capable ops only", async () => {
    await withServer((req, res) => res.end("{}"), async (port) => {
      const parser = makeParser(port);
      await parser.parse();
      const send = parser.tool("mail_users_messages_send")!;
      const sendProps = send.inputSchema.properties as Record<string, unknown>;
      const ct = sendProps.contentType as { enum?: string[] };
      assert.ok(ct.enum?.includes("application/octet-stream"), "media content type advertised");
      assert.ok(ct.enum?.includes("multipart/related"));
      assert.ok(sendProps.bodyBase64, "raw bytes input advertised");
      const get = parser.tool("mail_users_messages_get")!;
      const getProps = get.inputSchema.properties as Record<string, unknown>;
      assert.equal(getProps.contentType, undefined, "non-media ops unchanged");
      assert.equal(getProps.bodyBase64, undefined);
    });
  });

  it("routes uploadType=media to the simplePath with raw bytes", async () => {
    await withServer((req, res) => res.end("{}"), async (port, captured) => {
      const parser = makeParser(port);
      await parser.parse();
      const raw = Buffer.from("From: a@b.c\r\nSubject: hi\r\n\r\nbody");
      const res = await parser.execute("mail_users_messages_send", {
        userId: "me",
        contentType: "application/octet-stream",
        bodyBase64: raw.toString("base64"),
      });
      assert.equal(res.status, "success");
      assert.equal(captured.length, 1);
      const c = captured[0]!;
      assert.equal(c.method, "POST");
      assert.ok(c.url.includes("/upload/mail/v1/users/me/messages/send"), c.url);
      assert.ok(c.url.includes("uploadType=media"), c.url);
      assert.equal(c.body.toString(), raw.toString(), "raw bytes hit the wire");
      assert.equal(c.headers["content-type"], "application/octet-stream");
    });
  });

  it("routes uploadType=multipart to the simplePath with metadata + media parts", async () => {
    await withServer((req, res) => res.end("{}"), async (port, captured) => {
      const parser = makeParser(port);
      await parser.parse();
      const media = Buffer.from("raw mime bytes");
      const res = await parser.execute("mail_users_messages_send", {
        userId: "me",
        contentType: "multipart/related",
        body: {
          metadata: { labelIds: ["SENT"] },
          media: media.toString("base64"),
        },
      });
      assert.equal(res.status, "success");
      const c = captured[0]!;
      assert.ok(c.url.includes("uploadType=multipart"), c.url);
      const contentType = c.headers["content-type"] ?? "";
      assert.ok(contentType.startsWith("multipart/related"), contentType);
      const boundary = contentType.split("boundary=")[1]!;
      const text = c.body.toString("latin1");
      assert.ok(text.includes('"labelIds":["SENT"]'), "metadata part present");
      assert.ok(text.includes("raw mime bytes"), "media part present");
      assert.ok(text.includes(`--${boundary}--`), "closing boundary present");
    });
  });

  it("keeps the regular path + JSON body when the caller does not opt in", async () => {
    await withServer((req, res) => res.end("{}"), async (port, captured) => {
      const parser = makeParser(port);
      await parser.parse();
      const res = await parser.execute("mail_users_messages_send", {
        userId: "me",
        body: { raw: "abc" },
      });
      assert.equal(res.status, "success");
      const c = captured[0]!;
      // baseUrl override replaces the Discovery server (rootUrl+servicePath),
      // so the op path resolves against the origin without the mail/v1 prefix.
      assert.ok(c.url.includes("/users/me/messages/send"), c.url);
      assert.ok(!c.url.includes("uploadType"), "no media query by default");
      assert.equal(c.headers["content-type"], "application/json");
      assert.equal(c.body.toString(), '{"raw":"abc"}');
    });
  });
});
