// The property suite's seed, chosen once for every test file and printed before anything runs, so
// a failure in CI replays anywhere: HOPGRAPH_SEED=<seed> npm run test:props. Unset, the seed is
// fixed and the suite is the same on every run; HOPGRAPH_SEED=random draws one.

import type { TestProject } from "vitest/node";

const FIXED = 20261102;

declare module "vitest" {
  export interface ProvidedContext {
    seed: number;
  }
}

export default function setup(project: TestProject): void {
  const text = process.env.HOPGRAPH_SEED;
  let seed = FIXED;
  if (text === "random") seed = Math.floor(Math.random() * 0x7fffffff);
  else if (text !== undefined && text !== "") {
    seed = Number(text);
    if (!Number.isInteger(seed))
      throw new Error(`HOPGRAPH_SEED must be an integer or "random", not "${text}"`);
  }
  console.info(`[props] HOPGRAPH_SEED=${seed}${text === "random" ? " (random)" : ""}`);
  project.provide("seed", seed);
}
