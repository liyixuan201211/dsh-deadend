# Decay: why content, not time

This is the design note behind the one idea that makes `deadend` different from
a notebook of things that did not work.

## The failure mode being avoided

A ledger of failures is only useful if it is *true right now*. The obvious
implementation — record a dead end, expire it after N days — is wrong in both
directions, and both errors are costly.

Consider `MAX_AGE_DAYS = 60`, the rule used by the closest prior art
([dead-end-registry](https://github.com/karanb192/claude-code-hooks)):

**Too slow.** You record "`npm install sharp` fails: no prebuilt binary" on
Monday. On Tuesday you upgrade the toolchain and the lockfile, and the install
now works. The ledger still blocks, because 24 hours is much less than 60 days.
You hit exit 3, and the block is wrong. Do that a few times and you learn to
ignore the tool.

**Too fast.** You record "the `legacy-csv` importer cannot handle quoted
newlines" against a vendored dependency that will never change. On day 61 the
entry evaporates, and the next session walks straight back into it. Nothing about
the code changed; only the calendar did.

A clock is a proxy for "has the world changed?" and a bad one.

## What actually determines validity

The failure was a fact about a specific state of specific files. So:

> A dead end is authoritative exactly while the content it depended on is
> unchanged.

That is checkable, cheap (a hash per anchor), and needs no calibration. It is
also self-maintaining: nobody has to remember to expire anything.

## The falsifier test

An anchor is not "a file related to the problem". It is **the thing whose change
would make the recorded failure stop being true**. Ask:

> If this file changed, could the failure plausibly be gone? If not, it is not an
> anchor.

Good anchors for `npm install sharp` failing on a missing prebuilt binary:

- `package-lock.json` — a newer `sharp` may ship a binary for this platform
- `package.json` — the pinned version range may move

Bad anchors:

- the log file you pasted the error from (it can never change the outcome)
- `node_modules/` (noisy, ignored, and not a decision point)
- `README.md` (irrelevant, so it would never trigger decay — an anchor that never
  fires is worse than none, because it looks like diligence)

## Granularity

- **A file** anchors to the hash of its bytes.
- **A directory** anchors to a hash of a sorted manifest of `path + content
  hash` for every file underneath it.

Directories use `git ls-files` when possible, so `.gitignore` decides what
counts: build output and dependencies never make an anchor thrash. Outside a git
repository, a walk skips the usual noise (`node_modules`, `dist`, `target`,
`.venv`, …). A directory anchor therefore means "nothing about this tree
changed", which is what you want for a config directory or a schema folder.

A *deleted* anchor counts as changed, not as absent — deletion is a change.

## What happens on change

Nothing is deleted, and the block is not silently dropped. The entry becomes a
**suspect**:

- it stops being decisive (exit 4 instead of 3);
- the report names exactly which anchors moved and their before/after digests;
- it tells you how to resolve it — re-test, then `verify --still-fails` or
  `verify --now-works`.

So the decay is visible and actionable rather than silent. A suspect that is
never re-tested keeps showing up in `deadend status`, which is the correct
amount of pressure: it is a claim that has expired and is waiting to be
re-established.

## The entry that cannot decay

Vendored dependencies, upstream API limits, hardware constraints — some genuinely
have no local falsifier. `record` allows these with `--unanchored`, but:

- it refuses them *by default*, with a message explaining the reasoning;
- it prints a warning at record time;
- `status` and `gc` count them and keep warning;
- they block forever.

The alternative — quietly recording everything and expiring by clock — produces
a ledger whose accuracy you cannot reason about. Making the undecayable entries
loud is the point: you always know which claims are unfalsifiable, because they
are the ones the tool keeps complaining about.

## Honest positioning

Recording failures is not a new idea. `deadend` borrows it and takes a position
on the part everyone skips:

| | Prior art | `deadend` |
|---|---|---|
| What is captured | reverted approaches mined from transcripts | refutations you state, with evidence |
| Where it lives | `~/.claude/…`, per machine | `.deadend/ledger.jsonl`, in the repo, reviewable and committable |
| Match | keyword match on the prompt | normalised failure signature + command identity |
| Extraction | heuristics (+ optional model pass) | deterministic only |
| **Expiry** | **wall-clock age** | **content hash of the falsifiers** |
| Undecayable claims | not distinguished | refused by default, loud when allowed |
| Interface | editor hooks | exit codes, composable with any shell or CI |

The last three rows are the contribution.
