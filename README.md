# dsh-deadend

**Remember what did not work — and expire it automatically when the code it
depended on changes.**

A refutation ledger for coding agents, as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin.

```bash
dsh plugin --profile web add github:liyixuan201211/dsh-deadend
```

No install needed to try it:

```bash
npx --yes github:liyixuan201211/dsh-deadend --help
```

中文：一个**失败账本**。agent 每一轮新会话都会用同样的乐观重试同样的失败，代价重复支付。本插件把"试过且走不通"的方案记在仓库里，并在下一次尝试前先查一遍。关键在于：每条记录都带**锚点**（决定其真伪的文件的哈希）——锚点没变就拦截，锚点一变就自动降级为"待复测"，因为当初那个世界已经不在了。

---

## The problem is not forgetting. It is remembering badly.

Every memory system for agents stores **what worked**: facts, preferences,
summaries, embeddings. Almost nothing stores **what failed**. So the failure
loop repeats — the same broken install, the same two-hour detour, once per
session, forever.

The obvious fix is a list of things that did not work. The obvious fix is also
wrong, and worse than nothing:

> A note from six months ago saying "X does not work", written against code that
> has since changed, will confidently block a fix that now works.

A stale block is not a harmless annoyance. It is the tool lying to you, and a
tool that lies gets switched off. **The hard part of negative knowledge is not
recording it — it is invalidating it.**

## The idea: anchors

Every entry carries **anchors**: the files whose content would have to change for
the failure to stop being true.

| Anchors | Meaning | `check` exit |
|---|---|---|
| all unchanged | authoritative — it still fails | **`3`** |
| any changed / deleted | **suspect** — re-test it | **`4`** |
| nothing known | clear | `0` |
| entry refused (no anchors) | `record` declined | `5` |

Validity is judged by content, not by a clock. No `MAX_AGE_DAYS`, no
calibration — and it is self-maintaining, because nobody has to remember to
expire anything.

`record` **refuses to create an entry with no anchors.** That is enforced, not
advised:

```
$ deadend record --title "go build fails on cgo" --cmd "go build ./..."
Refusing to record: no anchors.

A dead end with nothing to watch can never expire, and a claim that can
never expire is indistinguishable from a bug. Name the files whose content
would have to change for this failure to stop being true.

Suggested anchors (they exist here):
  --anchor package.json

Or pass --unanchored if this genuinely has no local artifact — it will
block forever, and `deadend status` will keep saying so.
```

The undecayable case exists (an upstream API limit, a vendored dependency) and
`--unanchored` allows it — loudly, and counted in `deadend status`, so you always
know which of your claims are unfalsifiable.

## What it looks like

Before re-running something expensive, ask:

```bash
deadend check --cmd "npm install sharp" --log /tmp/last-install.log
```

```
⛔ BLOCKED — 1 recorded dead end matches, and its anchors are unchanged.

────────────────────────────────────────────────────────────────────────
dd_50e127c7d9c5  npm install sharp fails: no prebuilt binary for darwin-arm64
    matched   identical command
    recorded  2026-09-13 (today)
    attempt   npm install sharp  →  exit 1
    symptom   Error: Cannot find module sharp-darwin-arm64.node
    why       sharp ships prebuilt binaries and none exists for this platform/arch
    instead   npm rebuild sharp --build-from-source
    anchors   2 of 2 unchanged — still authoritative
      ✓ package.json
      ✓ package-lock.json
    evidence  install.log
────────────────────────────────────────────────────────────────────────

This is not a prohibition — it is a claim that was true, with its evidence.
If you think the world moved, re-test it and re-confirm:
  deadend verify dd_50e127c7d9c5 --still-fails --log <new-output>
```

Now change one line of `package-lock.json` and ask again:

```
⚠ SUSPECT — 1 recorded dead end matches, but the world it described has changed.

    anchors   1 of 2 changed — no longer authoritative
      ✓ package.json
      ✗ package-lock.json  f25e7d29 → 55eaf97b

Re-test it: it may now work.
  still fails?  deadend verify dd_50e127c7d9c5 --still-fails
  works now?    deadend verify dd_50e127c7d9c5 --now-works
```

That transition — authoritatively blocked, then honestly downgraded the moment
its evidence moved — is the whole plugin.

## Recording a failure

```bash
deadend record \
  --title "npm install sharp fails: no prebuilt binary for darwin-arm64" \
  --cmd "npm install sharp" --exit 1 --log /tmp/last-install.log \
  --why "sharp ships prebuilt binaries and publishes none for this platform/arch" \
  --retry "npm rebuild sharp --build-from-source (needs libvips)" \
  --anchor package.json --anchor package-lock.json \
  --evidence /tmp/last-install.log --tag native
```

`--log` is worth the trouble. The failure is hashed in a **normalised** form —
line and column numbers, absolute paths, temp directories, digests, UUIDs,
timestamps, durations and ANSI colour removed — so the same breakage is
recognised across sessions, machines, and differently-worded commands:

```bash
# Recorded as:  python app.py        + ModuleNotFoundError: No module named numpy
# Still caught: python3 app.py --verbose, same failure, different command
deadend check --cmd "python3 app.py --verbose" --log ./run.log   # -> exit 3
```

## Commands

```
deadend check   [--cmd C] [--log F|-] [--symptom T] [--title T] [-q] [--json]
deadend record  -t TITLE [--cmd C] [--exit N] [--log F|-] [--why W] [--retry R]
                [--anchor PATH]... [--unanchored] [--evidence E]... [--tag T]...
deadend verify  <id> (--still-fails | --now-works) [--log F] [--note N]
deadend list    [--status active|suspect|retired] [--all] [--json]
deadend show    <id> [--json]
deadend status  [--json]
deadend gc      [--dry-run] [--drop-retired] [--drop-undecayable]
deadend init
```

Exit codes are the interface, so `check` composes with any shell or CI gate:

```bash
deadend check --cmd "npm install sharp" -q || echo "already ruled out; not retrying"
```

## Matching is layered, so it never cries wolf

| Strength | Match | Decisive? |
|---|---|---|
| 3 | identical failure signature | yes |
| 2 | identical normalised command | yes |
| 1 | same command family, or similar title | **no** — shown as *related* |

Strength-1 matches never change the verdict. `npm install sharp` failing says
nothing about `npm install left-pad`, so installing something else is never
blocked — it is mentioned, with the earlier note attached. A gate that blocks
too much gets disabled, which protects nobody.

Command normalisation strips whitespace and leading wrappers (`sudo`, `time`,
`env`) and nothing else. Flags are part of the command.

## The ledger lives in your repository

```
<repo>/.deadend/ledger.jsonl     # append-only event log, one JSON object per line
```

Not in `~/.cache`, not per-machine. That is the design decision with the most
consequences:

- **Reviewable.** It arrives in a pull request as `+ {"v":1,"event":"record",…}` —
  a claim you can argue with.
- **Shared.** Your next session, your teammates, their agents, and CI all inherit
  it. A per-machine cache protects exactly one machine.
- **Auditable.** Every change keeps its reason: `verify` appends an observation
  rather than overwriting, and `gc` folds history into the entry so compaction
  never loses one.
- **Concurrency-safe.** Recording appends; there is no read-modify-write to race.

Identity is content-derived (`dd_` + `sha256(title | command | signature | anchor
paths)`), so two clones that record the same refutation produce the same id and
merging ledgers is a set union, not a de-duplication problem.

Full format: [`skills/deadend/reference/schema.md`](skills/deadend/reference/schema.md).

## Honest positioning

Recording failures is not a new idea, and this plugin does not claim it is.
The closest prior art is a Claude Code plugin,
[dead-end-registry](https://github.com/karanb192/claude-code-hooks), which mines
transcripts for reverted approaches; there is also academic work on
failure-aware shared memory
([Negative Knowledge](https://github.com/hch-wang/Negative_Knowledge), ICML 2026
AI4Research workshop) and "dead end registries" as a coordination mechanism in
automated-research templates.

| | Prior art | `dsh-deadend` |
|---|---|---|
| Captured | reverted approaches mined from transcripts | refutations you state, with evidence |
| Lives in | `~/.claude/…`, per machine | `.deadend/ledger.jsonl`, in the repo |
| Match | keyword match on the prompt | normalised failure signature + command identity |
| Extraction | heuristics (+ optional model pass) | deterministic, offline, no model |
| **Expiry** | **wall-clock age (e.g. 60 days)** | **content hash of the falsifiers** |
| Undecayable claims | not distinguished | refused by default; loud when allowed |
| Interface | editor hooks | exit codes, composable with any shell or CI |

Time-based expiry is wrong in both directions: too slow (a dependency bump that
invalidates a dead end this morning does not clear it for 60 days) and too fast
(a dead end about a frozen dependency vanishes on day 61 for no reason). The last
three rows are the contribution. Reasoning in full:
[`reference/decay.md`](skills/deadend/reference/decay.md).

## Design notes

**No boot-time code.** `cordis.patch.yml` is an empty patch, deliberately. A
plugin whose subject is "do not repeat mistakes" has no business inserting code
into the DSH process for every profile. The payload is a skill plus a CLI that the
skill runs through the visible shell tool.

**An event log, not a mutable document.** Append-only means no read-modify-write
races, clean diffs, and a preserved reason for every status change.

**`suspect` is never stored.** It is recomputed from anchors on every read. A
stored staleness flag would itself go stale — the exact bug being avoided.

**Refusal over a silent bad entry.** `record` rejects anchors that do not exist,
duplicate entries, and entries without anchors, rather than writing something
that will quietly mislead later.

## Installing as a DSH plugin

```bash
dsh plugin --profile web add github:liyixuan201211/dsh-deadend
```

This installs the skill (`skills/deadend/`), which teaches the agent to check
before it retries and record after it fails. The bundle patch adds nothing to the
boot graph; review `cordis.patch.yml`, `package.json` (no lifecycle scripts) and
`src/` if you want to verify that.

## Development

Requires Node >= 20. The sources are plain ESM JavaScript with JSDoc types, so
there is no build step and no install-time script — and the published `bin`
actually runs when installed. (They cannot be TypeScript: Node refuses to strip
types for files inside `node_modules`, which is precisely where the package lands
when it is installed or run through `npx`. The `installable` CI job guards that.)

```bash
npm test            # 58 tests
npm run typecheck   # tsc --noEmit over the JSDoc types
npm run check       # both
```

```
src/
  cli.js          exit-code contract and argument parsing
  engine.js       record / check / verify / gc, and the verdict rules
  anchors.js      hashing paths, detecting decay, suggesting anchors
  fingerprint.js  normalising failure output into a stable signature
  model.js        data model and event-log replay
  ledger.js       locating and reading/writing .deadend/ledger.jsonl
  report.js       human-readable rendering
  index.js        programmatic API
```

## License

MIT.
