// Checks that the code in the agent skill (skills/hopgraph/SKILL.md) compiles against the source,
// so the skill cannot teach an API the library no longer has. Its ```ts blocks are joined in order
// into one module, after declarations of the clients they call (db, wh), and type-checked with the
// project's tsconfig.
//
//   node tools/skill.js    (`npm run skill`, part of `npm run check`)
//
// No dependency, and plain JavaScript so that it runs on every Node the check runs on.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const skill = readFileSync(new URL("skills/hopgraph/SKILL.md", root), "utf8");
const blocks = [...skill.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length === 0) {
  console.error("skill: no ```ts block in skills/hopgraph/SKILL.md");
  process.exit(1);
}

// the clients the skill's loaders call, typed as the examples use them
const clients = `
type Opts = { readonly signal: AbortSignal };
declare const db: {
  tracksByIds(ids: string[], o: Opts): Promise<Map<string, { artistId?: number | string }>>;
  artistsByIds(ids: string[], o: Opts): Promise<Map<string, { name: string }>>;
};
declare const wh: {
  dryRun(ids: string[], o: Opts): Promise<number>;
  query(ids: string[], o: Opts & { maxBytes: number | undefined }): Promise<{ rows: Map<string, { plays: number }>; billedBytes: number }>;
};
`;

const dir = new URL("temp/skill/", root);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("snippets.ts", dir), `${clients}\n${blocks.join("\n")}\nexport {};\n`);
writeFileSync(
  new URL("tsconfig.json", dir),
  JSON.stringify({ extends: "../../tsconfig.json", include: ["snippets.ts"], exclude: [] }),
);
try {
  execFileSync("npx", ["tsc", "-p", "temp/skill/tsconfig.json"], {
    cwd: root,
    stdio: "inherit",
  });
} catch {
  console.error(
    "skill: the code in skills/hopgraph/SKILL.md does not compile (temp/skill/snippets.ts)",
  );
  process.exit(1);
}
console.log(`skill: ${blocks.length} code blocks of skills/hopgraph/SKILL.md compile`);
