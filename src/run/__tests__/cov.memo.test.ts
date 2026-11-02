// Memo (run/memo.ts): asking for a key no step claimed is an internal error, not a hang.

import { describe, expect, it } from "vitest";
import { HopgraphError } from "../../core/index.ts";
import { Memo } from "../memo.ts";

describe("Memo", () => {
  it("waiting for a key nobody claimed rejects with HG_INTERNAL", async () => {
    const memo = new Memo<{ readonly n: number }>();
    const error = await memo.wait("unclaimed").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HopgraphError);
    expect((error as HopgraphError).code).toBe("HG_INTERNAL");
  });
});
