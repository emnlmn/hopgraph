# Cost controls for warehouse reads on the label dashboard

**Ticket:** FIN-88 · **Requested by:** Finance

Last month a single dashboard load scanned 3 TB in the analytics warehouse. Finance wants every
warehouse read the dashboard makes to be cost-controlled, by the bytes the warehouse would bill:

- up to 1 GB: runs without asking;
- over 1 GB and up to 50 GB: stops and asks a person to approve the bytes before anything is
  billed;
- over 50 GB: refused.

(1 GB = 1,000,000,000 bytes; the warehouse bills in decimal units.)

The warehouse client is in `src/sources/warehouse.ts`. It has a free `dryRun` that returns what a
query would bill, and `query` takes a `maxBytes` limit above which the warehouse refuses the query
instead of billing it: we want every query sent with a limit. The warehouse team also asks for one
query per table per dashboard load, whatever the number of tracks (each query takes a slot in
their scheduler).

## The API

`src/streams.ts` exports `streamsFor(trackIds)`. Change it to:

```ts
streamsFor(trackIds: string[], approvals?: Record<string, number>): Promise<StreamsAnswer>

type StreamsAnswer =
  | { status: "done"; result: Map<string, TrackStats> }
  | {
      status: "needs-approval";
      result: Map<string, TrackStats>; // what could be read meanwhile
      gates: { id: string; bytes: number }[]; // what the approver is shown
      resume(approved: Record<string, number>): Promise<StreamsAnswer>; // approved bytes by gate id
    };
```

`TrackStats` and `toStats` stay as they are: a value that waits for approval or was refused shows
up as unknown, with its reason. `approvals` lets a caller pass approvals it already has (bytes by
gate id).

When the approver says yes, the dashboard calls `resume` with the gates' ids and bytes. A resume
must not bill again what the first round already read, and must not pay for another dry run of
what was already priced.

`npm test` and `npx tsc --noEmit` must pass when you're done.
