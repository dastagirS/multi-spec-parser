#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_TARGETS = 5;
const MAX_ARGUMENT_LENGTH = 16 * 1024;
const PACKAGE_NAME = "multi-spec-parser";
const SMOKE_TEXT = "openapi: 3.0.0\ninfo: {}\npaths:\n  /health:\n    get:\n      operationId: health\n      responses:\n        '200':\n          description: ok\n";

function requireArgument(value, name) {
  assert(typeof value === "string" && value.length > 0, `${name} is required`);
  assert(value.length < MAX_ARGUMENT_LENGTH, `${name} is too long`);
  return value;
}

function parseTargets(value) {
  assert(typeof value === "string", "target list must be a string");
  const targets = value.split(",").filter(Boolean);
  assert(targets.length > 0 && targets.length <= MAX_TARGETS, `target count must be 1-${MAX_TARGETS}`);
  assert(new Set(targets).size === targets.length, "target list contains duplicates");
  return targets;
}

function run(command, args, cwd) {
  assert(typeof command === "string" && command.length > 0, "command must be non-empty");
  assert(Array.isArray(args) && args.length > 0, "command arguments must be non-empty");
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

async function installPackage(packageFile, consumerDir) {
  assert(packageFile.endsWith(".tgz"), "package file must be an npm tarball");
  assert(consumerDir.length > 0, "consumer directory must be non-empty");
  await writeFile(join(consumerDir, "package.json"), JSON.stringify({ private: true }), "utf8");
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", packageFile], consumerDir);
}

async function verifyFiles(consumerDir, version, targets) {
  assert(consumerDir.length > 0, "consumer directory must be non-empty");
  assert(typeof version === "string" && version.length > 0, "package version must be non-empty");
  assert(Array.isArray(targets) && targets.length > 0, "target list must be non-empty");
  const findings = [];
  for (const target of targets) {
    const file = join(consumerDir, "node_modules", PACKAGE_NAME, "native", "prebuilds", target, "parser.node");
    try {
      const details = await stat(file);
      if (!details.isFile() || details.size === 0) findings.push(`native prebuild is empty: ${target}`);
    } catch {
      findings.push(`native prebuild is missing: ${target}`);
    }
  }
  try {
    const packageJson = JSON.parse(await readFile(join(consumerDir, "node_modules", PACKAGE_NAME, "package.json"), "utf8"));
    if (packageJson.name !== PACKAGE_NAME) findings.push("installed package name is incorrect");
    if (packageJson.version !== version) findings.push(`installed package version is ${packageJson.version}, expected ${version}`);
  } catch (error) {
    findings.push(`installed package metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (findings.length > 0) throw new Error(`package verification failed:\n- ${findings.join("\n- ")}`);
}

function runSmoke(consumerDir) {
  assert(consumerDir.length > 0, "consumer directory must be non-empty");
  assert(SMOKE_TEXT.includes("openapi:"), "smoke document must be OpenAPI");
  const script = `
    import { MultiSpecParser } from ${JSON.stringify(PACKAGE_NAME)};
    import { toStandardSchema } from ${JSON.stringify(`${PACKAGE_NAME}/standard-schema`)};
    const parser = new MultiSpecParser({ spec: { text: ${JSON.stringify(SMOKE_TEXT)} } });
    const parsed = await parser.parse();
    if (parsed.openapi !== "3.0.0") throw new Error("package YAML smoke test failed");
    const tool = parser.tool("health");
    if (!tool) throw new Error("package tool compilation smoke test failed");
    const directSchema = toStandardSchema(tool);
    if (typeof directSchema["~standard"].jsonSchema.input !== "function") throw new Error("package Standard JSON Schema smoke test failed");
    const parserSchema = parser.toStandardSchema(tool);
    const validation = await parserSchema["~standard"].validate({});
    if (!("value" in validation)) throw new Error("package Standard Schema smoke test failed");
    console.log("package consumer smoke test passed");
  `;
  run(process.execPath, ["--input-type=module", "-e", script], consumerDir);
}

async function main() {
  const packageFile = requireArgument(process.argv[2], "package tarball");
  const version = requireArgument(process.env.PACKAGE_VERSION, "PACKAGE_VERSION");
  const targets = parseTargets(process.argv[3] ?? "linux-x64");
  const consumerDir = await mkdtemp(join(tmpdir(), "multi-spec-parser-package-"));
  assert(consumerDir.length > 0, "temporary consumer directory must be created");
  try {
    await installPackage(packageFile, consumerDir);
    await verifyFiles(consumerDir, version, targets);
    runSmoke(consumerDir);
    console.log(`package verification passed: ${version} (${targets.join(", ")})`);
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
