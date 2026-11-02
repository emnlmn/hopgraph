// Runs the warehouse example's three requests and checks what it claims: a gated first run that
// read the free source and billed nothing, an approved run that scans once within its approval,
// and a resume on another instance whose price grew past the approval rejected without a scan.

import { CostChangedError } from "hopgraph";
import { describe, expect, it } from "vitest";
import { instance, request, warehouse } from "./warehouse.ts";

describe("examples/warehouse", () => {
  it("stops at a gate, loads once approved within the approval, and refuses a grown price", async () => {
    warehouse.bytesPerArtist = 4e9;
    warehouse.scans.length = 0;
    const app = instance();

    const first = await request(app);
    expect(first.status).toBe("gated");
    expect(first.billedBytes).toBe(0);
    expect(first.gates).toMatchObject([{ loader: "plays", keys: 3, bytes: 12e9 }]);
    expect(first.rows.get("a1")?.providers.profile.rows[0]?.fields.name).toBe("Mira Volk");
    expect(first.rows.get("a1")?.providers.recentPlays.unknown).toEqual([
      { reason: "awaiting_approval", bytes: 12e9 },
    ]);
    expect(warehouse.scans).toEqual([]);

    const approved = Object.fromEntries(first.gates.map((g) => [g.id, g.bytes]));
    const second = await request(app, { approved, prices: first.prices });
    expect(second.status).toBe("complete");
    expect(second.billedBytes).toBe(12e9);
    expect(second.rows.get("a2")?.providers.recentPlays.rows[0]?.fields).toEqual({
      plays: 30,
      saves: 0,
      casual: true,
    });
    expect(second.rows.get("a3")?.providers.recentPlays.outcome).toBe("absent");
    expect(warehouse.scans).toEqual([{ keys: 3, billed: 12e9 }]);

    warehouse.bytesPerArtist = 5e9;
    const refused = await request(instance(), { approved }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(CostChangedError);
    expect(refused).toMatchObject({ approved: 12e9, priced: 15e9 });
    expect(warehouse.scans).toHaveLength(1);
  });
});
