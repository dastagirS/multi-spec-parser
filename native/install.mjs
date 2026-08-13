import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const nativeDirectory = fileURLToPath(new URL("./", import.meta.url));
const platformArchitecture = `${process.platform}-${process.arch}`;
const prebuiltPath = join(nativeDirectory, "prebuilds", platformArchitecture, "parser.node");

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
  if (condition !== true) throw new Error(message);
}

function installNativeParser() {
  assertCondition(nativeDirectory.length > 0, "Native parser directory is empty");
  if (existsSync(prebuiltPath)) {
    console.log(`Using prebuilt native YAML parser for ${platformArchitecture}`);
    return;
  }
  const buildScript = join(nativeDirectory, "build.mjs");
  const result = spawnSync(process.execPath, [buildScript], { stdio: "inherit", windowsHide: true });
  if (result.error) throw new Error(`Native YAML fallback build failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Native YAML fallback build failed with exit code ${result.status}`);
  assertCondition(existsSync(join(nativeDirectory, "build", "Release", "parser.node")), "Native fallback build produced no addon");
}

installNativeParser();
