import { describe, expect, it } from "vitest";
import { artistBoxes, profileLabel } from "../src/page.ts";

describe("artist box", () => {
  it("shows the profile of a track's artist", async () => {
    const [box] = await artistBoxes(["t1"]);
    expect(box).toEqual({ track: "t1", title: "Glass Harbour", label: "profile", artist: "Mira Volk" });
  });

  it("maps each outcome to its text", () => {
    expect(profileLabel("found")).toBe("profile");
    expect(profileLabel("absent")).toBe("no profile");
    expect(profileLabel("unknown")).toBe("profile unavailable");
  });
});
