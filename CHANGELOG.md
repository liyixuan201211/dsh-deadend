# Changelog

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
