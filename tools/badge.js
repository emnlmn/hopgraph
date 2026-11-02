// Checks that the coverage badge in README.md shows the `lines` threshold in vitest.config.ts: the
// floor CI enforces, so the badge never claims more than a passing check guarantees. Raise both
// together.
//
//   node tools/badge.js    (`npm run badge`, part of `npm run check`)
//
// No dependency, and plain JavaScript so that it runs on every Node the check runs on.

import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const threshold = /thresholds:\s*{[^}]*\blines:\s*([\d.]+)/.exec(read("vitest.config.ts"))?.[1];
const badge = /img\.shields\.io\/badge\/coverage-([\d.]+)%25-/.exec(read("README.md"))?.[1];

if (threshold === undefined) fail("vitest.config.ts: no `lines` in coverage.thresholds");
if (badge === undefined) fail("README.md: no coverage badge");
if (Number(badge) !== Number(threshold))
  fail(`README.md: the coverage badge says ${badge}%, the lines threshold is ${threshold}%`);
console.log(`coverage badge: ${badge}%, as the lines threshold`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
