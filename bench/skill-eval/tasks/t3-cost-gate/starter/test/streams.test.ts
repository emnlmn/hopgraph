import { describe, expect, it } from "vitest";
import { streamsFor } from "../src/streams.ts";

describe("streamsFor", () => {
  it("reads titles, streams and skip rates", async () => {
    const answer = await streamsFor(["t001", "t002", "t007"]);
    expect(answer.status).toBe("done");
    expect(answer.result.get("t001")).toEqual({
      title: "Track 1",
      streams: { outcome: "found", value: 1000 },
      skipRate: { outcome: "found", value: 0.1 },
    });
    // t007 was never streamed
    expect(answer.result.get("t007")?.streams).toEqual({ outcome: "absent" });
  });
});
