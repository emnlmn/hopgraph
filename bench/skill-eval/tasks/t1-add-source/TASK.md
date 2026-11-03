# Show the record label on the track page

**Ticket:** CAT-412 · **Requested by:** Product (track page)

Product wants the track page to show the record label of each track's performer: the label's name
and its country.

Labels aren't in our database. They live in the labels service, owned by the rights team; our
client for it is `labelsApi` in `src/sources/labels.ts`. In our database an artist has an optional
`labelId` (unsigned artists have none).

## What to do

- Add a provider with id `labelInfo`, with the fields `name` and `country`, that can be read for
  tracks: `runner.read("track", ids, [...])` with the runner from `src/runner.ts`.
- The page shows "Independent" when the artist has no label and "Label unavailable" when we
  couldn't get it from the labels service. Those must stay distinguishable: a failed call to the
  labels service must not come out as "no label".
- The rights team says some `labelId`s in our database point to labels they have since removed;
  the service simply leaves ids it doesn't know out of its response. Treat those as no label.
- The labels service has a batch endpoint (`getMany`) and rate-limits us. Don't call it more than
  needed: a page of tracks should cost one call, not one per track or per artist.
- Our graph test runs `checkGraph(graph, { bases: ["track"] })` on the `graph` exported by
  `src/graph.ts`; it must report no problems.
- `trackInfo` and `artistProfile` must keep returning what they return today.

`npm test` and `npx tsc --noEmit` must pass when you're done. Add tests for the new behaviour if
you like.
