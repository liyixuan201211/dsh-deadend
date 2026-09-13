# Changelog

## 1.1.0 — 2026-09-13

Correctness release. Every fix below is a case where the ledger could have told
you something untrue — and for a tool whose only job is to be trusted, a
plausible lie is the worst kind of bug.

### Fixed

- **An empty or whitespace-only log produced a universal fingerprint.** The
  signature of nothing was `sha256("")`, so every entry recorded without a usable
  log shared one fingerprint, and a later `check` with any empty log would report
  an *identical failure signature* against an unrelated dead end. `signature` now
  returns `null` when there is nothing worth hashing.
- **Re-confirming an anchorless entry silently made it look anchored.** `[]` is
  truthy in JavaScript, so `verify --still-fails` on an entry with no anchors
  flipped `decay` from `none` to `anchored` — after which `status` stopped
  warning about an entry that still blocks forever.
- **`--unanchored` together with `--anchor` is refused**, instead of storing
  anchors that are displayed but never checked.
- **A directory anchor covering zero files is refused.** Its manifest can never
  change, so it was an undecayable entry wearing the costume of a properly
  anchored one.
- **Directory hashing no longer falls back to a filesystem walk when git reports
  zero files.** An empty answer from git is an answer; walking anyway pulled in
  gitignored build output and made anchors thrash.
- **An unreadable `--log` path is a usage error**, not a silent omission.
  Dropping it downgraded the check from signature matching to command matching,
  so a typo in a path could turn a BLOCKED into a CLEAR — a safety check must not
  fail open.
- **A non-integer `--exit` is rejected** rather than silently discarded.
- **`--force` no longer discards earlier notes**, and the duplicate message no
  longer claims it adds a separate entry (it replaces the entry with the same
  content-derived id, keeping that entry's history).

### Added

- **`deadend merge <ledger...>`** — union other ledgers into this one, which
  turns the set-union property the identity scheme was designed around into an
  actual command. The more recent observation wins on status and anchors;
  histories and notes are unioned.
- **`status` names the entries that need attention** (no anchors, or every anchor
  deleted) rather than only counting them, and `--json` exposes the same list, so
  it can gate CI.
- **`verify` reports when a re-confirmation could not re-pin anything**, instead
  of claiming the entry is authoritative again.
- A paste-able CI recipe in the README.
- New tests covering every fix above and `merge`.

## 1.0.0 — 2026-09-13

First release.

**The idea: a refutation ledger whose entries expire by content, not by clock.**
Each dead end carries *anchors* — the content hashes of the files whose change
would falsify it. While those hashes match, the entry blocks a retry; the moment
one changes, it degrades to a *suspect* and stops blocking, because the world it
described is gone.

### Added

- `deadend check` — consult the ledger before an attempt.
  Exits `3` when a recorded dead end is still authoritative, `4` when its anchors
  have changed (re-test), `0` when nothing is known. `--quiet` for scripted gates,
  `--json` for machines.
- `deadend record` — record a refutation, with anchors, reason, alternative and
  evidence. **Refuses entries that could never expire** and suggests anchors that
  exist in the repository.
- `deadend verify` — resolve a suspect: `--still-fails` re-pins the anchors to the
  current tree, `--now-works` retires the entry.
- `deadend list | show | status | gc | init`.
- Content-derived entry identity, so two clones that record the same refutation
  produce the same id and ledgers merge as a set union.
- Deterministic failure-signature normalisation: line/column references, paths,
  timestamps, UUIDs, digests, durations and ANSI codes are erased, so the same
  breakage matches across machines and across reworded commands.
- Layered matching — failure signature (decisive), exact command (decisive),
  command family / similar title (**hint only, never blocks**).
- In-repo, append-only event-log ledger at `.deadend/ledger.jsonl`, diffable and
  reviewable in a pull request.
- DSH skill (`skills/deadend/`) plus two references: `decay.md` (why
  content-addressed invalidation is right and time-based expiry is wrong in both
  directions) and `schema.md` (ledger format and exit codes).
- 58 tests, a typecheck, and a CI workflow that runs both.

### Notes

- Requires Node >= 20. The sources are plain ESM JavaScript with JSDoc types:
  no build step, and no install-time scripts. They cannot be TypeScript,
  because Node refuses to strip types for files inside `node_modules` — which is
  exactly where the package lands when it is installed or run through `npx`.
  `npm run typecheck` still checks the whole tree with `tsc --noEmit` (`checkJs`).
- The cordis patch is intentionally empty: this plugin adds nothing to the boot
  graph.
