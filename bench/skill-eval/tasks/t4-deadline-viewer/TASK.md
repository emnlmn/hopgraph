# Track list page: time budget and analytics permission

**Ticket:** WEB-207 · **Requested by:** Web team

Implement `renderPage(trackIds, user)` in `src/page.ts` (its types are already there). It returns
one row per track, in the order given: `{ track, title, streams }`, where `streams` is the track's
stream count from analytics, or one of:

- `"late"`: analytics didn't answer in time (or failed). The page has a hard budget of 300 ms:
  when analytics is slow, answer within the budget anyway, with every title, and show `"late"`
  for the streams.
- `"forbidden"`: the user lacks the `"analytics"` permission (`user.permissions`). Such users must
  not trigger any call to analytics, and must never be shown stream counts, including counts
  another user's request left in the shared cache.
- `"none"`: analytics has no data for the track (it leaves such tracks out of its response; new
  releases, mostly).

Titles come from the catalog database (`trackSummary`), stream counts from analytics
(`trackStreams`); both providers are in `src/graph.ts`. The runner and its cache
(`src/runner.ts`) are shared by every request and every user.

`npm test` and `npx tsc --noEmit` must pass when you're done.
