import { existsSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const nativeDirectory = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(nativeDirectory, "parser.c");
const platformArchitecture = `${process.platform}-${process.arch}`;
const outputPath = process.argv.includes("--prebuild-current")
  ? join(nativeDirectory, "prebuilds", platformArchitecture, "parser.node")
  : join(nativeDirectory, "build", "Release", "parser.node");
const MAX_HEADERS_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_HEADERS_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_HEADER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_CHUNKS = 100_000;
const MAX_NODE_LIBRARY_BYTES = 10 * 1024 * 1024;
const HEADER_DOWNLOAD_TIMEOUT_MS = 60_000;
const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
  if (condition !== true) throw new Error(message);
}

function existingNodeIncludeDirectory() {
  const candidates = [
    process.env.MULTI_SPEC_PARSER_NODE_HEADERS,
    resolve(process.execPath, "..", "..", "include", "node"),
    "/usr/include/node",
    "/usr/local/include/node",
  ].filter((candidate) => candidate !== undefined && candidate.length > 0);
  const result = candidates.filter((candidate, index) => existsSync(join(candidate, "node_api.h")) && candidates.indexOf(candidate) === index);
  assertCondition(result.every((candidate) => isAbsolute(candidate)), "Node header path must be absolute");
  return result[0];
}

function readTarField(archive, offset, length) {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end && archive[cursor] !== 0) cursor += 1;
  return archive.subarray(offset, cursor).toString("utf8");
}

function readTarSize(archive, offset) {
  const field = readTarField(archive, offset, 12).trim();
  if (field.length === 0) return 0;
  assertCondition(/^[0-7]+$/.test(field), "Node header archive contains an invalid tar size");
  return Number.parseInt(field, 8);
}

function safeHeaderPath(root, relativePath) {
  const target = resolve(root, relativePath);
  const checked = relative(root, target);
  const withinRoot = checked !== "" && !checked.startsWith("..") && !isAbsolute(checked);
  assertCondition(withinRoot, "Node header archive contains a path traversal entry");
  assertCondition(relativePath.length > 0 && !relativePath.includes("\\"), "Node header archive contains an invalid path");
  return target;
}

function extractNodeHeaders(archiveBytes, targetDirectory) {
  assertCondition(Buffer.isBuffer(archiveBytes), "Node header archive must be a Buffer");
  assertCondition(archiveBytes.length <= MAX_HEADERS_ARCHIVE_BYTES, "Node header archive is too large");
  const archive = gunzipSync(archiveBytes, { maxOutputLength: MAX_HEADERS_UNCOMPRESSED_BYTES });
  assertCondition(archive.length <= MAX_HEADERS_UNCOMPRESSED_BYTES, "Uncompressed Node header archive is too large");
  let offset = 0;
  let extracted = 0;
  while (offset + 512 <= archive.length) {
    const name = readTarField(archive, offset, 100);
    if (name.length === 0) break;
    const size = readTarSize(archive, offset + 124);
    const contentOffset = offset + 512;
    const contentEnd = contentOffset + size;
    assertCondition(contentEnd <= archive.length, "Node header archive contains a truncated file");
    const type = archive[offset + 156];
    const marker = name.startsWith("include/node/") ? "include/node/" : "/include/node/";
    const markerIndex = name.indexOf(marker);
    if (markerIndex >= 0 && (type === 0 || type === 48)) {
      assertCondition(size <= MAX_HEADER_FILE_BYTES, "Node header file is too large");
      const target = safeHeaderPath(targetDirectory, name.slice(markerIndex + marker.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, archive.subarray(contentOffset, contentEnd), { mode: 0o644 });
      extracted += 1;
    }
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  assertCondition(extracted > 0, "Node header archive contained no headers");
  assertCondition(existsSync(join(targetDirectory, "node_api.h")), "Downloaded Node headers are incomplete");
}

async function readBoundedResponse(response, limit) {
  assertCondition(response.body !== null, "Node header response has no body");
  assertCondition(Number.isSafeInteger(limit) && limit > 0, "Node header response limit is invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit || chunks.length >= MAX_HEADER_CHUNKS) {
        try {
          await reader.cancel();
        } catch {
          // The bounded-size error is the actionable failure.
        }
        throw new Error("Node header download exceeded its size limit");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  assertCondition(size <= limit, "Node header response exceeded its size limit");
  return Buffer.concat(chunks, size);
}

async function downloadNodeHeaders() {
  const version = process.versions.node;
  assertCondition(NODE_VERSION_PATTERN.test(version), `Unsupported Node.js version: ${version}`);
  const cacheDirectory = join(homedir(), ".cache", "multi-spec-parser", "node-headers", version);
  const headerPath = join(cacheDirectory, "node_api.h");
  if (existsSync(headerPath)) return cacheDirectory;
  if (existsSync(cacheDirectory)) rmSync(cacheDirectory, { recursive: true, force: true });
  const url = `https://nodejs.org/download/release/v${version}/node-v${version}-headers.tar.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(HEADER_DOWNLOAD_TIMEOUT_MS) });
  assertCondition(response.ok, `Could not download Node headers: ${response.status} ${response.statusText}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  assertCondition(contentLength === 0 || contentLength <= MAX_HEADERS_ARCHIVE_BYTES, "Node header download is too large");
  const archiveBytes = await readBoundedResponse(response, MAX_HEADERS_ARCHIVE_BYTES);
  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}`;
  rmSync(temporaryDirectory, { recursive: true, force: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  try {
    extractNodeHeaders(archiveBytes, temporaryDirectory);
    mkdirSync(dirname(cacheDirectory), { recursive: true });
    if (!existsSync(cacheDirectory)) renameSync(temporaryDirectory, cacheDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  assertCondition(existsSync(headerPath), `Node headers were not cached at ${headerPath}`);
  return cacheDirectory;
}

async function nodeIncludeDirectory() {
  const existing = existingNodeIncludeDirectory();
  if (existing !== undefined) return existing;
  return downloadNodeHeaders();
}

async function downloadNodeLibrary() {
  const version = process.versions.node;
  assertCondition(NODE_VERSION_PATTERN.test(version), `Unsupported Node.js version: ${version}`);
  const target = process.arch === "x64" ? "win-x64" : process.arch === "arm64" ? "win-arm64" : undefined;
  assertCondition(target !== undefined, `Windows native build does not support ${process.arch}`);
  const cacheDirectory = join(homedir(), ".cache", "multi-spec-parser", "node-headers", version);
  const libraryPath = join(cacheDirectory, "node.lib");
  if (existsSync(libraryPath)) return libraryPath;
  const url = `https://nodejs.org/download/release/v${version}/${target}/node.lib`;
  const response = await fetch(url, { signal: AbortSignal.timeout(HEADER_DOWNLOAD_TIMEOUT_MS) });
  assertCondition(response.ok, `Could not download Node library: ${response.status} ${response.statusText}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  assertCondition(contentLength === 0 || contentLength <= MAX_NODE_LIBRARY_BYTES, "Node library download is too large");
  const libraryBytes = await readBoundedResponse(response, MAX_NODE_LIBRARY_BYTES);
  mkdirSync(cacheDirectory, { recursive: true });
  const temporaryPath = `${libraryPath}.tmp-${process.pid}`;
  rmSync(temporaryPath, { force: true });
  writeFileSync(temporaryPath, libraryBytes, { mode: 0o644 });
  try {
    if (!existsSync(libraryPath)) renameSync(temporaryPath, libraryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  assertCondition(existsSync(libraryPath), `Node library was not cached at ${libraryPath}`);
  return libraryPath;
}

async function nodeLibraryPath() {
  if (process.platform !== "win32") return undefined;
  const candidates = [
    process.env.MULTI_SPEC_PARSER_NODE_LIB,
    join(dirname(process.execPath), "node.lib"),
  ].filter((candidate) => candidate !== undefined && candidate.length > 0);
  const result = candidates.find((candidate) => existsSync(candidate));
  if (result !== undefined) {
    assertCondition(isAbsolute(result), "Node library path must be absolute");
    return result;
  }
  return downloadNodeLibrary();
}

function compilerCommand() {
  const configured = process.env.CC;
  const candidates = configured ? [configured] : process.platform === "win32" ? ["clang-cl", "cl"] : ["cc", "clang", "gcc"];
  for (const candidate of candidates) {
    assertCondition(typeof candidate === "string" && candidate.length > 0, "Compiler command is empty");
    const probeArguments = process.platform === "win32" && candidate === "cl" ? ["/?"] : ["--version"];
    const probe = spawnSync(candidate, probeArguments, { encoding: "utf8", windowsHide: true });
    if (probe.status === 0 || (process.platform === "win32" && candidate === "cl" && `${probe.stdout}\n${probe.stderr}`.includes("Microsoft"))) return candidate;
  }
  throw new Error(`No C compiler found for ${platformArchitecture}; set CC or install a compiler`);
}

function compileUnix(includeDirectory) {
  const linkerArguments = process.platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup"]
    : ["-shared", "-fPIC", "-Wl,-z,now", "-Wl,-z,relro"];
  return ["-O3", "-std=c11", "-Wall", "-Wextra", "-Werror", ...linkerArguments, `-I${includeDirectory}`, "-o", outputPath, sourcePath];
}

function compileWindows(includeDirectory, libraryPath) {
  assertCondition(process.platform === "win32", "Windows compilation selected on another platform");
  assertCondition(includeDirectory.length > 0, "Windows Node include directory is empty");
  assertCondition(libraryPath !== undefined && isAbsolute(libraryPath), "Windows Node library path is invalid");
  return ["/LD", "/O2", "/W4", `/I${includeDirectory}`, `/Fe:${outputPath}`, sourcePath, "/link", libraryPath];
}

async function build() {
  assertCondition(existsSync(sourcePath), `Native source is missing: ${sourcePath}`);
  const includeDirectory = await nodeIncludeDirectory();
  const compiler = compilerCommand();
  const libraryPath = await nodeLibraryPath();
  const commandArguments = process.platform === "win32"
    ? compileWindows(includeDirectory, libraryPath)
    : compileUnix(includeDirectory);
  mkdirSync(dirname(outputPath), { recursive: true });
  const result = spawnSync(compiler, commandArguments, { stdio: "inherit", windowsHide: true });
  if (result.error) throw new Error(`Native YAML compilation failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Native YAML compilation failed with exit code ${result.status}`);
  assertCondition(existsSync(outputPath), `Native compiler did not produce ${outputPath}`);
  assertCondition(outputPath.endsWith(".node"), "Native output must be a Node addon");
  console.log(`Built native YAML parser for ${platformArchitecture}: ${outputPath}`);
}

try {
  await build();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
