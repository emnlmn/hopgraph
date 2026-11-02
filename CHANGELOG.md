# Changelog

Every change a consumer can see, newest first. Before 1.0 a release may break the API; each break
has its exact before and after in [MIGRATION.md](MIGRATION.md). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). [Versioning](README.md#versioning), in the
README, says which changes each kind of release may bring.

## Unreleased

### Fixed

- `runner.read` names each row by the id of its key as the run parsed it, so an entity whose key
  schema transforms the key (`"07"` to 7) and whose `id` needs the parsed key no longer throws a
  `TypeError` after the run; `g.ref` names its row the same way. An `id` that throws on a key now
  rejects the read with a `ValidationError` naming the row by its place. `read` and `g.ref` take
  what the key's schema accepts (its input type, `KeyInputOf`); loads, links and results still see
  what it parses to.

## [0.1.0] - 2026-11-02

First release.
