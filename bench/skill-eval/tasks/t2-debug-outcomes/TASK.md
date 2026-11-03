# Artist box shows the wrong text

**Ticket:** CAT-431 · **Reported by:** Support, from user reports

The artist box on the track page shows one of three texts (`src/page.ts`): "profile" (we show the
artist's profile), "no profile" (the artist has no profile in our catalog) and "profile
unavailable" (we couldn't read it right now; try again later). Users report it picks the wrong
one:

1. **Removed artists show "profile unavailable" forever.** For example track t7, "Paper Moons":
   its artist was removed from the catalog last year, yet the box says "profile unavailable" on
   every visit and users keep retrying. It should say "no profile".
2. **During last Tuesday's database outage, every track said "no profile".** Users concluded the
   artists had been deleted and filed complaints. When we can't read the database, the box must
   say "profile unavailable".
3. **Some older tracks always show "profile unavailable"** although their artist exists and has a
   profile: t3 "Low Tide" by Kit Lune, t4 "Saltwater" by Ode Ferris. Newer tracks by the same
   artists are fine. Support thinks these are tracks from the 2019 catalog import.

## What to do

Fix these at the source: the outcome the graph gives for `artistProfile` must be right, so that
every consumer gets it right, not only this page. Don't change `profileLabel` in `src/page.ts`:
its mapping is signed off by design. You can't change the database or its data either
(`src/sources/db.ts` stands in for the real one).

`npm test` and `npx tsc --noEmit` must pass when you're done. Add regression tests if you like.
