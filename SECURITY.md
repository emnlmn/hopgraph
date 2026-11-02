# Security

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: the repository's
**Security** tab, **Report a vulnerability**. Do not open a public issue. Include what an attacker
can do, the affected version or commit, and the smallest graph or run that reproduces it. The fix
is prepared in private and released with an advisory, which credits you unless you ask otherwise.

Security fixes go to `main` and, once there are releases, to the latest one. Before 1.0 there is
no other supported line.

## What the library guarantees

Hopgraph runs in the application's process, does no I/O of its own (every read is a function the
application hands it) and never logs. What it reports, it reports through the run's result, the
errors it throws and the spans it hands a tracer (`RunOptions.tracer`). In all of these:
- **A personal key appears only as its digest.** For an entity declared `personal: true`, a key
  shows in a result only as `digest(entity, keyId)`, the function the application passes in
  `RunOptions`, or the SHA-256 of the entity and the key id when it passes none: in row steps (`RowStep.ref`), provider rows (`ProviderRow.ref`) and lineage
  (`LinkStep.from`, `LinkStep.to`). The digest is computed once per key per run. One place holds
  the key as the caller gave it: the result of a runner's `read`, which keeps each row under the id
  of the key it was asked for, so that the caller looks the row up by its own key.
- **The trace holds no key at all.** `TraceStep` is counts per step and loader, and failures by
  code. A span's attributes are ids (loaders, steps, gates, connectors), counts, bytes,
  milliseconds and outcomes; its events say a call was retried, with the failure's code; an error
  recorded on it is a code and a class.
- **A source's error message never leaves the run.** A load or a dry run that throws fails its keys
  and is kept by its error's own code and class name (`LoadError.code`, `LoadError.class`) and the
  number of keys it took, never its message, which may hold the values it read. A failed statement
  a load reports is a code and a count.
- **The library's own errors name declarations, not data.** Builder and plan errors name entities,
  loaders, relations, providers and routes; `CostChangedError` names gate ids and byte counts; a
  `ValidationError` names base rows by the ids the caller gave them, and the keys of a `read` by
  their place (`keys[2]`). None holds a key or a value.
- **Ids hold no key in clear.** A gate id is the loader id and a SHA-256 of the loader's version,
  the restriction and the keys to load, a personal key entered with its digest. A cache entry key
  is the loader id, its version and a SHA-256 of the key id, what the load reads, the run values
  that are data and the restriction (`src/run/ids.ts`).
- **Runs that share their loads share only what their cache would.** A run given an `inflight`
  object waits for another run's answer only under the same cache entry, restriction included,
  and only an answer the cache would keep (found or absent, retention not `none`).
- **Shared health holds no key.** The `health` object holds connector names, counts and times.

## What it leaves to the application

- **The digest.** The guarantee above is only as strong as `digest`. Keys are often guessable (an
  email, a phone number), so a plain hash of one can be reversed by trying candidates: use a keyed
  hash (an HMAC with a secret) or a lookup table, never an unsalted hash. The default, for a run given
  no digest, is an unsalted SHA-256: it keeps a key out of sight, not out of reach. Give a digest
  wherever a personal key can be guessed.
- **Non-personal keys.** They appear in clear in results. Declare `personal: true` on every entity
  whose key identifies a person.
- **Values.** Field values, link attributes (`LinkStep.attrs`), carried attributes and coverage
  labels are the application's data, returned as its loaders and projections produced them. The
  library does not mask them; the application renders them through its own masking.
- **The cache port.** It receives every found and absent answer, values included. The store behind
  it must be protected as the sources are; `restriction` keeps one viewer's entries from another's
  only if the application builds it to. The same holds for the answers an `inflight` object
  passes between runs in memory.
- **Errors declared fatal.** An error `RunOptions.fatal` accepts rejects the run as it was thrown,
  message included: it is the application's own error. `fatal` and `retryable` see each error as it
  was thrown.
- **Connector access.** `readable` decides, per connector, whether this caller may read a source; a
  source it refuses is never touched, cache included. Who may read what is the application's
  decision.

A report that one of the guarantees above does not hold (a key, a value or a message where the
list says there is none) is a vulnerability: report it as above.
