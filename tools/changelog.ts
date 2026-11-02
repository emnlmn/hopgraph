// The release side of CHANGELOG.md and MIGRATION.md. Both keep their next entries under
// "## Unreleased"; a release turns that heading into the version's and opens a new, empty one.
//
//   node tools/changelog.ts stamp          `npm version`'s hook: stamps the version in package.json
//                                          (already bumped) and today's date, and stages both files.
//                                          Refuses a release whose CHANGELOG section is empty.
//   node tools/changelog.ts notes <ver>    prints that version's CHANGELOG section, for the GitHub
//                                          Release.
//
// No dependency: the files are plain Markdown with one level-2 heading per release.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const UNRELEASED = "## Unreleased";

/** The body under `heading`, up to the next level-2 heading. */
function section(text: string, heading: string): string | undefined {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) return undefined;
  const body = text.slice(start + heading.length + 1);
  const end = body.search(/^## /m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

function stamp(file: string, version: string, date: string, required: boolean): void {
  const text = readFileSync(file, "utf8");
  const body = section(text, UNRELEASED);
  if (body === undefined) throw new Error(`${file}: no "${UNRELEASED}" heading`);
  if (body === "" && required) throw new Error(`${file}: nothing under "${UNRELEASED}" to release`);
  // ponytail: an empty MIGRATION section still gets its heading, so every version is listed there
  const next = text.replace(`${UNRELEASED}\n`, `${UNRELEASED}\n\n## [${version}] - ${date}\n`);
  writeFileSync(file, next);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "stamp") {
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const date = new Date().toISOString().slice(0, 10);
  stamp("CHANGELOG.md", version, date, true);
  stamp("MIGRATION.md", version, date, false);
  execFileSync("git", ["add", "CHANGELOG.md", "MIGRATION.md"]);
} else if (mode === "notes" && arg) {
  const version = arg.replace(/^v/, "");
  const text = readFileSync("CHANGELOG.md", "utf8");
  const heading = text.match(
    new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\][^\\n]*$`, "m"),
  );
  const body = heading ? section(text, heading[0]) : undefined;
  if (!body) throw new Error(`CHANGELOG.md: no section for ${version}`);
  process.stdout.write(`${body}\n`);
} else {
  throw new Error("usage: node tools/changelog.ts stamp | notes <version>");
}
