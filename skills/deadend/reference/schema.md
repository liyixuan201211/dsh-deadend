# Ledger format

## Location

```
<repo-root>/.deadend/ledger.jsonl
```

One JSON object per line. Append-only.

The repository root is the nearest ancestor directory containing `.deadend/`;
failing that, the nearest containing `.git/`; failing that, the working
directory. So the tool works from any subdirectory of your project.

## Why an event log

Three properties, each of which matters:

1. **No read-modify-write.** Recording appends a line. Two agents working in the
   same repository cannot clobber each other's entries, and a partially written
   file loses at most the last event.
2. **It diffs.** A pull request shows `+ {"v":1,"event":"record",…}` — a claim,
   reviewable like any other change.
3. **Every change keeps its reason.** `verify` does not overwrite the entry; it
   appends the observation, so the history of a belief survives.

`deadend gc` compacts the log to one `record` event per entry. Replay folds
history into the entry, so compaction loses intermediate events but never an
observation.

## Events

All events carry `v: 1`. An unrecognised `v` or an unparseable line is reported
as a ledger error and skipped — never silently ignored.

### `record`

```json
{
  "v": 1,
  "event": "record",
  "at": "2026-09-13T14:24:15.727Z",
  "entry": {
    "id": "dd_50e127c7d9c5",
    "title": "npm install sharp fails: no prebuilt binary for darwin-arm64",
    "createdAt": "2026-09-13T14:24:15.727Z",
    "updatedAt": "2026-09-13T14:24:15.727Z",
    "command": "npm install sharp",
    "normalized": "npm install sharp",
    "family": "npm install",
    "exitCode": 1,
    "fingerprint": "sha256:0c557061e58050d9140d447b7461ce69…",
    "excerpt": "Error: Cannot find module sharp-darwin-arm64.node",
    "why": "sharp ships prebuilt binaries and publishes none for this platform/arch",
    "retry": "npm rebuild sharp --build-from-source",
    "evidence": ["install.log"],
    "tags": ["native"],
    "anchors": [
      { "path": "package.json", "hash": "sha256:f25e7d29…", "kind": "file" },
      { "path": "package-lock.json", "hash": "sha256:9c1b…", "kind": "file" }
    ],
    "decay": "anchored",
    "status": "active",
    "retiredAt": null,
    "retireReason": null,
    "notes": [],
    "history": []
  }
}
```

Re-recording an id that was retired writes a new `record` event carrying the
previous `history` forward and a note that the failure recurred.

### `verify`

```json
{
  "v": 1,
  "event": "verify",
  "at": "2026-09-13T15:02:44.101Z",
  "id": "dd_50e127c7d9c5",
  "outcome": "still-fails",
  "anchors": [{ "path": "package.json", "hash": "sha256:f25e7d29…", "kind": "file" }],
  "note": "retested after lockfile bump"
}
```

- `still-fails` re-pins `anchors` to the current tree and returns the entry to
  `active`. This is what makes a suspect authoritative again: the claim has been
  re-observed against the world as it is.
- `now-works` sets `status: "retired"`.

### `note`

```json
{ "v": 1, "event": "note", "at": "…", "id": "dd_50e127c7d9c5", "text": "…" }
```

Free-form annotation; appended to `notes` and `history`.

## Status model

`status` is stored as `active` or `retired`. **`suspect` is never stored** — it
is derived at read time by re-hashing the anchors. That is deliberate: a stored
`suspect` flag would itself go stale, which is the bug this tool exists to avoid.

| effective status | condition | `check` exit |
|---|---|---|
| `active` | not retired, all anchors unchanged (or `decay: "none"`) | `3` (blocked) |
| `suspect` | not retired, ≥1 anchor changed or missing | `4` |
| `retired` | `verify --now-works` was recorded | ignored (`0`) |

## Identity

```
id = "dd_" + sha256(
  title.trim().toLowerCase() + "|" +
  normalizedCommand          + "|" +
  fingerprint                + "|" +
  sorted(anchorPaths)
).slice(0, 12)
```

Content-derived, not random. Two consequences:

- recording the same dead end twice is detected as a duplicate rather than
  creating a near-identical twin;
- two clones of the repository — or two teammates — that record the same
  refutation produce the **same id**, so merging ledgers is a set union instead
  of a de-duplication problem.

## Matching rules

`check` scores each non-retired entry and separates decisive matches from hints:

| Strength | Match | Decisive? |
|---|---|---|
| 3 | identical failure signature | yes |
| 2 | identical normalised command | yes |
| 1 | same command family, or ≥50 % title-token overlap | **no** — reported as *related* |

Strength-1 matches never change the verdict. `npm install sharp` failing says
nothing about `npm install left-pad`; blocking there would be false confidence,
and a gate that cries wolf gets switched off.

Command normalisation strips whitespace and leading wrappers (`sudo`, `time`,
`command`, `nohup`, `env`) and nothing else. Flags are part of the command: two
commands that differ in flags are two different commands.

Command family is the tool plus its subcommand for known multi-command tools
(`npm install`, `git push`, `cargo build`), otherwise the tool name.

## Signature normalisation

`fingerprint = sha256` over the folded form of the lines that look like the
failure (or, if none do, the last five non-empty lines). Before hashing, each
line has the following erased, so that two runs of the same failure agree:

- ANSI colour codes
- absolute and relative **paths** → basename
- `:line:col`, `line N`, `row N` references
- ISO timestamps, UUIDs, `0x…` addresses, long hex digests
- quantities with units (`3.7s`, `120ms`, `4 MB`)
- bare numbers of 4+ digits

Kept on purpose: error codes (`ENOENT`, `TS2304`), identifiers, and the wording
of the message. The hash is case-folded; the stored `excerpt` is not, so reports
stay readable.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | clear, or the command succeeded |
| `1` | unexpected error |
| `2` | usage error |
| `3` | **blocked** — a recorded dead end matches and is still authoritative |
| `4` | **suspect** — a recorded dead end matches, but its anchors changed |
| `5` | **refused** — `record` declined (no anchors, missing anchor, or duplicate) |
