import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outputPath = fileURLToPath(new URL("../dist", import.meta.url));
assert(outputPath.endsWith("/dist") || outputPath.endsWith("\\dist"), "clean target must be dist");
assert(outputPath.length > 5, "clean target must be an absolute project path");
rmSync(outputPath, { recursive: true, force: true });
