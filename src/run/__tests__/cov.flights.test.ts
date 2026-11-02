// Flights shared by the runs of a process (run/flights.ts), where the runs' own paths never meet
// the case: a second start of an entry already in flight, and a stale landing.

import { describe, expect, it } from "vitest";
import { Flights } from "../flights.ts";

describe("Flights", () => {
  it("gives back no way to land an entry another run is already loading, and shares its answer", async () => {
    const flights = new Flights();
    const land = flights.start("e");
    expect(land).toBeTypeOf("function");
    expect(flights.start("e")).toBeUndefined();
    expect(flights.size).toBe(1);

    const waiting = flights.waiting("e");
    land?.(undefined);
    expect(await waiting).toBeUndefined();
    expect(flights.size).toBe(0);
  });

  it("a landing that comes late does not remove the flight of a newer load of the same entry", () => {
    const flights = new Flights();
    const first = flights.start("e");
    first?.(undefined);
    const second = flights.start("e");
    expect(second).toBeTypeOf("function");

    first?.(undefined);
    expect(flights.size).toBe(1);
    second?.(undefined);
    expect(flights.size).toBe(0);
  });
});
