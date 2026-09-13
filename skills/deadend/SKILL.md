---
name: deadend
description: "Keep a ledger of approaches that were tried and did not work, and expire each one automatically when the code it depended on changes. Use BEFORE retrying something that may have failed before (a build, test, install, migration, dependency upgrade, codegen step), AFTER a failure that cost real time, when the user says 之前试过 / we tried this already / why does this keep failing, or when a check reports a recorded dead end. 中文：记录试过但没走通的方案，并在其依赖的代码变化后自动失效；在重试构建/测试/安装/迁移之前，或在一次代价较高的失败之后使用。"
license: MIT
# This skill asks the agent to run shell commands and read files, so it declares
# Bash, Read and Write. Declaring the truth is the point of the ecosystem it
# belongs to.
allowed-tools: Bash, Read, Write
metadata:
  version: "1.0.0"
  date: "2026-09-13"
  upstream: "https://github.com/liyixuan201211/dsh-deadend"
---

# deadend

Agents do not remember failures. Every new session meets the same broken build
with the same optimism, tries the same thing, and pays the same cost again.

`deadend` is a ledger of **refutations** — approaches that were tried and did not
work — kept in your repository, and consulted before the next attempt.

## The one idea

**A dead end must expire.**

Recording failures is easy and mostly useless. A note from six months ago saying
"X does not work", against code that has since changed, will confidently block a
fix that now works. Naive failure-memory is worse than no failure-memory.

So every entry carries **anchors**: the content hashes of the files whose change
would falsify it.

| Anchors | Meaning | What you do |
|---|---|---|
| all unchanged | **authoritative** — exit `3` | Do not re-run it unchanged. Read the entry; it carries the evidence. |
| any changed | **suspect** — exit `4` | The world moved. Re-test it; it may work now. |
| re-tested, still broken | `verify --still-fails` | Anchors are re-pinned; it is authoritative again. |
| re-tested, fixed | `verify --now-works` | Retired. It stays as history. |

Validity is judged by content, not by a clock. That is the whole design.

## Set up the command once per session

The tool ships with this plugin. Prefer the installed binary, and fall back to
running it straight from the repository:

```bash
de() {
  if command -v deadend >/dev/null 2>&1; then deadend "$@"
  else npx --yes github:liyixuan201211/dsh-deadend "$@"
  fi
}
```

The ledger lives at `.deadend/ledger.jsonl` in the repository root. `deadend`
finds the root itself (nearest `.deadend`, else the git root), so it works from
any subdirectory.

## Moment 1 — before an attempt (the one that saves money)

Before re-running something expensive or previously troublesome, ask:

```bash
de check --cmd "npm install sharp"
```

If you have the output of a previous failure, pass it too. This is much stronger
than matching the command, because it recognises the *same failure* behind a
differently-worded command:

```bash
de check --cmd "pnpm add sharp" --log /tmp/last-install.log
```

- **exit 0, CLEAR** — nothing has been ruled out. Proceed.
- **exit 3, BLOCKED** — this was already proven not to work, and nothing it
  depended on has changed. **Stop.** Read the entry: it names the reason, the
  evidence, and what to do instead. Do not re-run it unchanged just to confirm.
- **exit 4, SUSPECT** — it was ruled out once, but the code it depended on has
  changed since. Proceed, but treat it as unknown: re-test, then record the
  result (Moment 3).

For a scripted gate, `--quiet` prints nothing and only sets the exit code:

```bash
de check --cmd "npm install sharp" -q || echo "known dead end; see .deadend/ledger.jsonl"
```

## Moment 2 — after a failure worth not repeating

Record it. The value comes from the entry being *specific enough to act on*, so
include the reason and, ideally, what to do instead:

```bash
de record \
  --title "npm install sharp fails: no prebuilt binary for darwin-arm64" \
  --cmd "npm install sharp" \
  --exit 1 \
  --log /tmp/last-install.log \
  --why "sharp ships prebuilt binaries and publishes none for this platform/arch" \
  --retry "npm rebuild sharp --build-from-source (needs libvips)" \
  --anchor package.json --anchor package-lock.json \
  --evidence /tmp/last-install.log
```

`--log` is worth the trouble: the tool hashes a normalised form of the failure
(line numbers, temp paths, digests, timings and colour codes removed) so the same
breakage is recognised later on another machine, or under a different command.

### Anchors are not optional, and that is deliberate

`record` **refuses** an entry with no anchors, and tells you which of the
repository's manifests exist to anchor to. The reasoning:

> A dead end with nothing to watch can never expire, and a claim that can never
> expire is indistinguishable from a bug.

If a failure genuinely has no local artifact to watch — an upstream API that
rejects a payload, a vendor limit — pass `--unanchored`. It will block forever,
and `deadend status` will keep saying so, which is the honest outcome.

Always anchor to what the command actually read. For `npm install x` that is
`package.json` (and the lockfile if there is one); for a compiler error, the
source file; for a codegen step, the schema.

## Moment 3 — after re-testing a suspect

```bash
de verify dd_50e127c7d9c5 --still-fails --log /tmp/retest.log   # re-pin, blocks again
de verify dd_50e127c7d9c5 --now-works                            # retire it
```

Also record the outcome when a **blocked** attempt turns out to be stale — that
is how the ledger stays true.

## Reading the ledger

```bash
de list                 # active + suspect, newest first
de list --status retired --all
de show dd_50e127c7d9c5 # one entry in full, including its history
de status               # counts, plus the entries that need attention
de gc --drop-retired    # compact the event log
de merge other.jsonl    # union another clone's ledger into this one
```

`de status` **names** every entry that needs attention: ones with no anchors
(they block forever), and ones whose anchors have all been deleted (nothing is
left to watch, so they cannot be re-confirmed). Treat that list as work to do — a
ledger full of unfalsifiable entries is a ledger that will lie to you.

Entry identity is content-derived, so `de merge` is a genuine set union: the same
refutation recorded by a teammate, or by you on another machine, carries the same
id and merges cleanly.

## The ledger is not allowed to lie

`record` refuses four things, and each refusal exists because the alternative is
an entry that misleads later:

| Refusal | Why it would have lied |
|---|---|
| no anchors | it could never expire, so it blocks forever |
| a missing anchor path | it would never be watched |
| a directory covering **zero** files | its manifest can never change — undecayable, while looking anchored |
| `--unanchored` **with** `--anchor` | anchors stored but never checked |

If you hit one of these, the fix is to name the file whose change would falsify
the claim — not to reach for `--unanchored`.

## When not to use this

Judgement matters more than coverage here; a noisy ledger gets ignored.

- **Do not record trivia.** A typo you fixed in ten seconds is not a dead end.
- **Do not record a failure you do not understand.** "It didn't work" with no
  reason is worse than nothing, because it will block the next, better attempt.
- **Do not record success.** This ledger is only about refutations; `git log`
  already records what worked.
- **Do not let a block end the investigation.** Exit 3 means "unchanged, this
  fails". It does not mean "give up". It means: read the entry, and either use
  the recorded alternative, or change one of the anchors and re-test.

## Commit the ledger

`.deadend/ledger.jsonl` is an append-only event log inside the repository. Commit
it. That is what makes it worth more than a private note:

- your next session inherits it instead of rediscovering it;
- a teammate — human or agent — gets the same protection;
- it shows up in a pull request, where it can be reviewed like any other claim;
- CI can gate on it (`deadend check -q`).

It is also yours: the failures your project actually hit, in your repository, not
an opaque global blob.

## Further reading

- `reference/decay.md` — why invalidation is content-addressed, and why
  time-based expiry is wrong in both directions.
- `reference/schema.md` — the ledger format, event types, and identity rule.
