// The artist box on the track page. The design team signed off these three texts; each one means
// something different to a user, so the mapping below must stay as it is.

import { artistProfile, trackInfo } from "./graph.ts";
import { runner } from "./runner.ts";

export type ProfileLabel = "profile" | "no profile" | "profile unavailable";

/** found: we show the profile; absent: the artist has no profile; unknown: we could not read it. */
export function profileLabel(outcome: "found" | "absent" | "unknown"): ProfileLabel {
  switch (outcome) {
    case "found":
      return "profile";
    case "absent":
      return "no profile";
    case "unknown":
      return "profile unavailable";
  }
}

export interface ArtistBox {
  readonly track: string;
  readonly title: string | undefined;
  readonly label: ProfileLabel;
  readonly artist: string | undefined;
}

/** The artist box of each track, in the order asked. */
export async function artistBoxes(trackIds: string[]): Promise<ArtistBox[]> {
  const result = await runner.read("track", trackIds, [trackInfo, artistProfile]);
  return trackIds.map((track) => {
    const providers = result.rows.get(track)?.providers;
    const profile = providers?.artistProfile;
    return {
      track,
      title: providers?.trackInfo.rows[0]?.fields.title,
      label: profileLabel(profile?.outcome ?? "unknown"),
      artist: profile?.rows[0]?.fields.name,
    };
  });
}
