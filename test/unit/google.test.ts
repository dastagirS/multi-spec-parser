import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSpec } from "../../src/parse-spec.js";
import type { GoogleDiscoveryDoc } from "../../src/types.js";

/** Synthetic discovery doc exercising every Google quirk the adapter handles. */
function makeDoc(): GoogleDiscoveryDoc {
  return {
    kind: "discovery#restDescription",
    name: "mail",
    version: "v1",
    title: "Mail API",
    rootUrl: "https://mail.googleapis.com/",
    servicePath: "/v1/",
    baseUrl: "https://mail.googleapis.com/v1/",
    resources: {
      users: {
        methods: {
          list: {
            id: "mail.users.messages.list",
            path: "users/{userId}/messages",
            flatPath: "users/{userId}/messages",
            httpMethod: "GET",
            description: "List messages.\nSecond line ignored as summary.",
            parameters: {
              userId: { type: "string", location: "path", required: true },
              q: { type: "string", location: "query", repeated: true },
              maxResults: { type: "integer", location: "query", default: "100" },
              anything: { type: "any", location: "query" },
            },
            response: { $ref: "ListMessagesResponse" },
            scopes: ["https://www.googleapis.com/auth/mail.readonly"],
          },
          send: {
            id: "mail.users.messages.send",
            path: "users/{userId}/messages/send",
            flatPath: "users/{userId}/messages/send",
            httpMethod: "POST",
            description: "Send a message.",
            supportsMediaUpload: true,
            mediaUpload: {
              accept: ["message/rfc822"],
              protocols: {
                simple: { multipart: true, path: "/upload/gmail/v1/users/{userId}/messages/send" },
                resumable: { multipart: true, path: "/resumable/upload/gmail/v1/users/{userId}/messages/send" },
              },
            },
            request: { $ref: "Message", parameterName: "message" },
            response: { $ref: "Message" },
          },
        },
        resources: {
          attachments: {
            methods: {
              get: {
                id: "mail.users.messages.attachments.get",
                path: "users/{userId}/messages/{messageId}/attachments/{id}",
                httpMethod: "GET",
                supportsMediaDownload: true,
                response: { $ref: "MessageAttachment" },
              },
            },
          },
        },
      },
    },
    schemas: {
      Message: {
        type: "object",
        properties: {
          id: { type: "string" },
          snippet: { type: "string" },
          payload: { $ref: "MessagePart" },
          labels: { type: "array", items: { type: "string" } },
        },
      },
      MessagePart: { type: "object", properties: { mimeType: { type: "string" } } },
      ListMessagesResponse: {
        type: "object",
        properties: { messages: { type: "array", items: { $ref: "Message" } } },
      },
      MessageAttachment: { type: "object", properties: { data: { type: "string", format: "byte" } } },
    },
    parameters: {
      prettyPrint: { type: "boolean", location: "query", default: "true" },
      alt: { type: "string", location: "query" },
    },
  };
}

describe("Google Discovery adapter", () => {
  it("extracts operations from nested resources with dotted tags", () => {
    const parsed = parseSpec(makeDoc() as unknown as Record<string, unknown>);
    assert.equal(parsed.specFormat, "google-discovery");
    assert.equal(parsed.operations.length, 3);
    const list = parsed.operations.find((o) => o.toolName === "mail_users_messages_list")!;
    assert.deepEqual(list.tags, ["mail", "users"]);
    const attachment = parsed.operations.find(
      (o) => o.toolName === "mail_users_messages_attachments_get",
    )!;
    assert.deepEqual(attachment.tags, ["mail", "users", "attachments"]);
  });

  it("builds base URL from rootUrl + servicePath", () => {
    const parsed = parseSpec(makeDoc() as unknown as Record<string, unknown>);
    assert.equal(parsed.baseUrl, "https://mail.googleapis.com/v1/");
  });

  it("filters type:any at conversion (no recursive cleanup pass needed)", () => {
    const parsed = parseSpec(makeDoc() as unknown as Record<string, unknown>);
    const list = parsed.operations.find((o) => o.toolName === "mail_users_messages_list")!;
    const anything = list.parameters.find((p) => p.name === "anything")!;
    // Bare schema without `type` — Ajv accepts it, and nothing recursively
    // strips `any` anywhere (the O(n²) domany pass is gone).
    assert.equal(anything.schema.type, undefined);
    // Every other param keeps its type.
    assert.equal((list.parameters.find((p) => p.name === "userId")!.schema as { type?: string }).type, "string");
  });

  it("repeated:true params become array schemas with the item type preserved", () => {
    const parsed = parseSpec(makeDoc() as unknown as Record<string, unknown>);
    const list = parsed.operations.find((o) => o.toolName === "mail_users_messages_list")!;
    const q = list.parameters.find((p) => p.name === "q")!;
    assert.equal(q.schema.type, "array");
    assert.equal((q.schema.items as { type?: string }).type, "string");
  });

  it("coerces string defaults to the param's numeric type", () => {
    const parsed = parseSpec(makeDoc() as unknown as Record<string, unknown>);
    const list = parsed.operations.find((o) => o.toolName === "mail_users_messages_list")!;
    const maxResults = list.parameters.find((p) => p.name === "maxResults")!;
    assert.equal(maxResults.schema.default, 100);
  });

  it("injects global params into every operation unless already defined", () => {
    const parsed = parseSpec(makeDoc() as unknown as Record<string, unknown>);
    for (const op of parsed.operations) {
      const names = op.parameters.map((p) => p.name);
      assert.ok(names.includes("prettyPrint"), `${op.toolName} missing global prettyPrint`);
      assert.ok(names.includes("alt"), `${op.toolName} missing global alt`);
    }
    // Local params are not duplicated.
    const list = parsed.operations.find((o) => o.toolName === "mail_users_messages_list")!;
    assert.equal(list.parameters.filter((p) => p.name === "userId").length, 1);
  });

  it("prefers flatPath over legacy path", () => {
    const doc = makeDoc();
    const list = doc.resources!.users!.methods!.list as { path: string; flatPath: string };
    list.path = "users/{userId}/messages?legacy=1"; // legacy path with junk
    const parsed = parseSpec(doc as unknown as Record<string, unknown>);
    const op = parsed.operations.find((o) => o.toolName === "mail_users_messages_list")!;
    // flatPath wins; discovery paths get a leading slash for URL concat.
    assert.equal(op.path, "/users/{userId}/messages");
  });

  it("converts bare $ref schema names to component pointers", () => {
    const parsed = parseSpec(makeDoc() as unknown as Record<string, unknown>);
    const list = parsed.operations.find((o) => o.toolName === "mail_users_messages_list")!;
    assert.equal(list.outputSchema?.$ref, "#/components/schemas/ListMessagesResponse");
    const payload = parsed.schemas.Message!.properties!.payload as { $ref?: string };
    assert.equal(payload.$ref, "#/components/schemas/MessagePart");
  });

  it("converts per-property required booleans into required[]", () => {
    const doc = makeDoc();
    const message = doc.schemas!.Message!;
    message.properties!.id!.required = true;
    const parsed = parseSpec(doc as unknown as Record<string, unknown>);
    assert.deepEqual(parsed.schemas.Message!.required, ["id"]);
  });
});
