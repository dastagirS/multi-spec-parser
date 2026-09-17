import assert from "node:assert/strict";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_SPEC_BYTES } from "./parse-spec.js";

const SOURCE_TIMEOUT_MS = 60_000;
const SOURCE_URL_LENGTH_MAX = 8 * 1024;
const RESPONSE_CHUNK_COUNT_MAX = 1_000_000;

export interface TemporarySpecFile {
  readonly path: string;
  readonly size: number;
  cleanup(): Promise<void>;
}

export async function loadSpecUrl(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  assert(typeof sourceUrl === "string", "source URL must be a string");
  assert(signal === undefined || signal instanceof AbortSignal, "signal must be an AbortSignal");
  const text = await readResponseText(await fetchSpecResponse(sourceUrl, signal), MAX_SPEC_BYTES);
  assert(typeof text === "string", "loaded source must be text");
  return text;
}

export async function loadSpecUrlToTemporaryFile(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<TemporarySpecFile> {
  assert(typeof sourceUrl === "string", "source URL must be a string");
  assert(signal === undefined || signal instanceof AbortSignal, "signal must be an AbortSignal");
  const directory = await mkdtemp(join(tmpdir(), "multi-spec-parser-"));
  const path = join(directory, "source.yaml");
  try {
    const response = await fetchSpecResponse(sourceUrl, signal);
    if (!response.body) throw new Error("MultiSpecParser: source response has no body.");
    const file = await open(path, "wx");
    let size = 0;
    let chunkCount = 0;
    const reader = response.body.getReader();
    try {
      while (chunkCount < RESPONSE_CHUNK_COUNT_MAX) {
        const next = await reader.read();
        if (next.done) break;
        chunkCount += 1;
        size += next.value.byteLength;
        if (size > MAX_SPEC_BYTES) {
          await reader.cancel();
          throw new Error(`MultiSpecParser: source exceeds ${MAX_SPEC_BYTES} bytes.`);
        }
        await writeAll(file, next.value);
      }
      if (chunkCount >= RESPONSE_CHUNK_COUNT_MAX) {
        await reader.cancel();
        throw new Error("MultiSpecParser: source response has too many chunks.");
      }
    } finally {
      reader.releaseLock();
      await file.close();
    }
    if (size === 0) throw new Error("MultiSpecParser: source response is empty.");
    let cleaned = false;
    return {
      path,
      size,
      async cleanup(): Promise<void> {
        assert(typeof cleaned === "boolean", "cleanup state must be boolean");
        assert(directory.length > 0, "temporary directory must be non-empty");
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  assert(file.fd >= 0, "temporary source file must be open");
  assert(bytes.byteLength > 0, "source chunk must be non-empty");
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten === 0) throw new Error("MultiSpecParser: temporary source write made no progress.");
    offset += bytesWritten;
  }
  assert(offset === bytes.byteLength, "complete source chunk must be written");
}

async function fetchSpecResponse(sourceUrl: string, signal?: AbortSignal): Promise<Response> {
  assert(typeof sourceUrl === "string", "source URL must be a string");
  assert(signal === undefined || signal instanceof AbortSignal, "signal must be an AbortSignal");
  if (sourceUrl.length === 0 || sourceUrl.length > SOURCE_URL_LENGTH_MAX) {
    throw new TypeError("MultiSpecParser: spec.url must be a bounded non-empty URL.");
  }
  const parsedUrl = new URL(sourceUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError("MultiSpecParser: spec.url must use http or https.");
  }
  const timeoutSignal = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  const response = await fetch(parsedUrl, {
    headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`MultiSpecParser: source request failed with HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_SPEC_BYTES) {
    await response.body?.cancel();
    throw new Error(`MultiSpecParser: source exceeds ${MAX_SPEC_BYTES} bytes.`);
  }
  assert(response.status >= 200 && response.status < 300, "source response must be successful");
  return response;
}

async function readResponseText(response: Response, sizeMax: number): Promise<string> {
  assert(response instanceof Response, "response must be a Response");
  assert(Number.isInteger(sizeMax) && sizeMax > 0, "size limit must be positive");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textParts: string[] = [];
  let chunkCount = 0;
  let size = 0;
  try {
    while (chunkCount < RESPONSE_CHUNK_COUNT_MAX) {
      const next = await reader.read();
      if (next.done) break;
      chunkCount += 1;
      size += next.value.byteLength;
      if (size > sizeMax) {
        await reader.cancel();
        throw new Error(`MultiSpecParser: source exceeds ${sizeMax} bytes.`);
      }
      textParts.push(decoder.decode(next.value, { stream: true }));
    }
    if (chunkCount >= RESPONSE_CHUNK_COUNT_MAX) {
      await reader.cancel();
      throw new Error("MultiSpecParser: source response has too many chunks.");
    }
  } finally {
    reader.releaseLock();
  }
  textParts.push(decoder.decode());
  assert(size <= sizeMax, "response bytes must respect the limit");
  assert(textParts.length <= RESPONSE_CHUNK_COUNT_MAX + 1, "decoded part count must be bounded");
  return textParts.join("");
}
