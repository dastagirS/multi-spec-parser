/**
 * Download the battle-test fixtures into test/fixtures/. Idempotent: skips
 * files that already exist unless --force is passed.
 *
 * The fixtures are git-ignored (they are ~22MB of re-fetchable upstream spec
 * snapshots), so a fresh clone must run `npm run fixtures` once before
 * `npm run check`. URLs are the documented/official sources from
 * docs/specparse-res.md.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL("../../../test/fixtures", import.meta.url));

const FIXTURES: Array<{ file: string; url: string }> = [
  {
    file: "petstore3.json",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
  },
  {
    file: "booking.yaml",
    url: "https://developers.booking.com/_bundle/demand/docs/open-api/demand-api.yaml",
  },
  {
    file: "booking.json",
    url: "https://developers.booking.com/_bundle/demand/docs/open-api/demand-api.json",
  },
  {
    file: "stripe.json",
    // Pin the fixture because operation-count gates must not change when upstream master moves.
    url: "https://raw.githubusercontent.com/stripe/openapi/7258e5084c3b31defae5c5a400a1e39e50a5b796/openapi/spec3.json",
  },
  {
    file: "github.json",
    // Pin the fixture because operation-count gates must not change when upstream main moves.
    url: "https://raw.githubusercontent.com/github/rest-api-description/8114b0d0e23240dfe45374e2daf01651a4729210/descriptions/api.github.com/api.github.com.json",
  },
  {
    file: "swagger2.json",
    url: "https://petstore.swagger.io/v2/swagger.json",
  },
  {
    file: "slack.json",
    url: "https://raw.githubusercontent.com/slackapi/slack-api-specs/refs/heads/master/web-api/slack_web_openapi_v2_without_examples.json",
  },
];

const force = process.argv.includes("--force");
mkdirSync(FIXTURES_DIR, { recursive: true });

let downloaded = 0;
let skipped = 0;
for (const { file, url } of FIXTURES) {
  const dest = `${FIXTURES_DIR}/${file}`;
  if (!force && existsSync(dest)) {
    skipped += 1;
    continue;
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  writeFileSync(dest, text);
  downloaded += 1;
  console.log(`  fetched ${file} (${(text.length / 1024).toFixed(0)}KB)`);
}

console.log(`fixtures: ${downloaded} downloaded, ${skipped} skipped → ${FIXTURES_DIR}`);
if (downloaded > 0) {
  console.log("Next: npm run check");
}
