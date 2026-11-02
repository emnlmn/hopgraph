// Running a plan: a plan node fed by a node the plan does not hold is a bug of the planner's, and
// the run fails with it rather than wait for an input that never comes.

import { expect, it } from "vitest";
import { type Evaluators, execute } from "../execute.ts";
import type { Plan } from "../plan.ts";

it("a node fed by a node the plan does not hold fails the run, HG_INTERNAL, before it does anything", async () => {
  const plan: Plan = {
    routes: [],
    nodes: [{ id: "base:track", work: { kind: "base", entity: "track" }, feeds: ["ghost"] }],
  };
  const touched: string[] = [];
  const evaluators = new Proxy({} as Evaluators, {
    get: (_target, name) => {
      touched.push(String(name));
      return undefined;
    },
  });

  await expect(execute(plan, evaluators, [])).rejects.toMatchObject({
    code: "HG_INTERNAL",
    message: expect.stringContaining('no plan node "ghost"'),
  });
  expect(touched).toEqual([]);
});
