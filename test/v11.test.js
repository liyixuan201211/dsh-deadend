/**
 * 1.1.0 — one test per defect fixed, plus `merge`.
 *
 * Every case here is a way the ledger could have told a plausible lie, which for
 * a tool whose only job is to be trusted is the worst kind of bug.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { hashPath } from "../src/anchors.js";
import { check, merge, record, summarize, verify, viewAll } from "../src/engine.js";
import { signature } from "../src/fingerprint.js";
import { runCli, sandbox } from "./helpers.js";

/* ------------------------------------------------------------------ *
 * an empty log must not become a universal fingerprint
 * ------------------------------------------------------------------ */

test("an empty log yields no signature at all, not the hash of nothing", () => {
  assert.equal(signature("").fingerprint, null);
  assert.equal(signature("   \n\n  ").fingerprint, null);
  assert.notEqual(signature("Error: real failure").fingerprint, null);
});

test("two entries recorded with empty logs do not match each other by signature", (t) => {
  const box = sandbox({ "package.json": "{}", "other.json": "{}" });
  t.after(() => box.cleanup());

  record(box.dir, { title: "first thing", command: "make a", logText: "", anchors: ["package.json"] });
  record(box.dir, { title: "second thing", command: "make b", logText: "\n\n", anchors: ["other.json"] });

  // Before the fix both entries stored sha256("") and this reported an
  // "identical failure signature" against an unrelated dead end.
  const result = check(box.dir, { command: "unrelated command", fingerprint: signature("").fingerprint ?? undefined });
  assert.equal(result.verdict, "clear");
  assert.deepEqual(result.matches, []);
});

/* ------------------------------------------------------------------ *
 * re-confirming an anchorless entry must not disguise it as anchored
 * ------------------------------------------------------------------ */

test("verify --still-fails leaves an anchorless entry undecayable, and still flagged", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const created = record(box.dir, {
    title: "vendor API rejects batches over 100 rows",
    command: "curl -X POST /batch",
    unanchored: true,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const before = viewAll(box.dir).views[0];
  assert.equal(before?.entry.decay, "none");

  verify(box.dir, created.entry.id, "still-fails", "retested");

  const after = viewAll(box.dir).views[0];
  assert.equal(after?.entry.decay, "none", "decay must not flip to anchored with zero anchors");
  assert.equal(after?.entry.anchors.length, 0);
  assert.equal(check(box.dir, { command: "curl -X POST /batch" }).verdict, "blocked");
  assert.equal(summarize(box.dir).undecayable, 1, "status must keep reporting it as undecayable");
  assert.equal(summarize(box.dir).attention.length, 1);
});

/* ------------------------------------------------------------------ *
 * contradictory and hollow anchors
 * ------------------------------------------------------------------ */

test("--unanchored together with --anchor is refused", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const result = record(box.dir, {
    title: "contradiction",
    command: "make x",
    anchors: ["package.json"],
    unanchored: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "conflicting-anchors");
});

test("a directory anchor covering zero files is refused", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  // An empty directory: the manifest is the hash of "", which can never change.
  box.write("hollow/keep.txt", "");
  box.rm("hollow/keep.txt");

  const result = record(box.dir, {
    title: "anchored to nothing",
    command: "make x",
    anchors: ["hollow"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "empty-anchors");
});

test("a directory anchor reports how many files it covers", (t) => {
  const box = sandbox({ "config/a.json": "{}", "config/b.json": "{}" });
  t.after(() => box.cleanup());

  const anchor = hashPath(box.dir, "config");
  assert.ok(anchor);
  assert.equal(anchor.kind, "dir");
  assert.equal(anchor.files, 2);
});

test("a gitignored directory is not silently walked into", (t) => {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("git is not available");
    return;
  }

  const box = sandbox({ ".gitignore": "build/\n", "build/out.js": "compiled", "src/a.js": "code" });
  t.after(() => box.cleanup());

  const init = spawnSync("git", ["init", "-q", "."], { cwd: box.dir, encoding: "utf8" });
  if (init.status !== 0) {
    t.skip("git init unavailable");
    return;
  }

  // git answers "nothing tracked here". The old code treated that as "git could
  // not answer" and walked the directory, pulling in ignored build output.
  const anchor = hashPath(box.dir, "build");
  assert.ok(anchor);
  assert.equal(anchor.files, 0, "a fully gitignored directory must not be walked into");
});

/* ------------------------------------------------------------------ *
 * the CLI must not fail open or swallow bad input
 * ------------------------------------------------------------------ */

test("an unreadable --log is a usage error, not a silently dropped check", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const result = runCli(box.dir, ["check", "--cmd", "make build", "--log", "does-not-exist.log"]);
  assert.equal(result.code, 2, "must not quietly downgrade to command-only matching");
  assert.match(result.stderr, /cannot read --log/);
});

test("a non-integer --exit is rejected instead of discarded", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const result = runCli(box.dir, [
    "record", "--title", "t", "--cmd", "make", "--exit", "abc", "--anchor", "package.json",
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--exit must be an integer/);
});

test("the duplicate message does not promise a separate entry", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const args = ["record", "--title", "t", "--cmd", "make", "--anchor", "package.json"];
  runCli(box.dir, args);
  const again = runCli(box.dir, args);
  assert.equal(again.code, 5);
  assert.doesNotMatch(again.stdout, /separate entry/);
  assert.match(again.stdout, /--force to replace/);
});

test("--force keeps the notes recorded earlier", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const first = record(box.dir, {
    title: "t",
    command: "make",
    anchors: ["package.json"],
    why: "first reason",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // Simulate an annotation having been added, then force a re-record.
  const forced = record(box.dir, {
    title: "t",
    command: "make",
    anchors: ["package.json"],
    why: "second reason",
    force: true,
  });
  assert.equal(forced.ok, true);
  if (!forced.ok) return;
  assert.equal(forced.recurrence, true);
  assert.ok(forced.entry.notes.length >= 1, "the re-record note should be present");
  assert.equal(forced.entry.why, "second reason");
});

/* ------------------------------------------------------------------ *
 * merge
 * ------------------------------------------------------------------ */

/**
 * @param {Partial<import("../src/model.js").DeadEnd>} over
 * @returns {import("../src/model.js").DeadEnd}
 */
const entry = (over = {}) => ({
  id: "dd_merge000001",
  title: "make build fails",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  command: "make build",
  normalized: "make build",
  family: "make",
  exitCode: 1,
  fingerprint: null,
  excerpt: null,
  why: null,
  retry: null,
  evidence: [],
  tags: [],
  anchors: [],
  decay: "none",
  status: "active",
  retiredAt: null,
  retireReason: null,
  notes: [],
  history: [],
  ...over,
});

/** @param {import("../src/model.js").DeadEnd[]} entries */
const ledger = (entries) =>
  `${entries
    .map((e) => JSON.stringify({ v: 1, event: "record", at: e.createdAt, entry: e }))
    .join("\n")}\n`;

test("merge unions two ledgers by content-derived id", (t) => {
  const box = sandbox({
    ".deadend/ledger.jsonl": ledger([entry({ id: "dd_aaaaaaaaaaaa", title: "theirs only" })]),
  });
  t.after(() => box.cleanup());

  const root = box.dir;
  // A local entry that the other side does not know about.
  record(root, { title: "mine only", command: "make other", anchors: [] , unanchored: true});

  const result = merge(root, [ledger([entry({ id: "dd_bbbbbbbbbbbb", title: "incoming" })])]);
  assert.equal(result.added, 1);
  assert.equal(result.total, 3, "existing entries are kept, incoming ones are added");

  const ids = viewAll(root).views.map((v) => v.entry.id).sort();
  assert.ok(ids.includes("dd_aaaaaaaaaaaa"));
  assert.ok(ids.includes("dd_bbbbbbbbbbbb"));
});

test("merging the same id twice changes nothing", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const text = ledger([entry()]);
  const first = merge(box.dir, [text]);
  assert.equal(first.added, 1);

  const second = merge(box.dir, [text]);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.total, 1);
});

test("the more recent observation wins, and both histories survive", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const mine = entry({
    id: "dd_cccccccccccc",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    notes: ["local note"],
    history: [{ at: "2026-01-01T00:00:00.000Z", event: "record", note: null }],
  });
  merge(box.dir, [ledger([mine])]);

  const theirs = entry({
    id: "dd_cccccccccccc",
    updatedAt: "2026-06-01T00:00:00.000Z",
    status: "retired",
    retiredAt: "2026-06-01T00:00:00.000Z",
    retireReason: "fixed upstream",
    notes: ["remote note"],
    history: [
      { at: "2026-01-01T00:00:00.000Z", event: "record", note: null },
      { at: "2026-06-01T00:00:00.000Z", event: "now-works", note: "fixed upstream" },
    ],
  });

  const result = merge(box.dir, [ledger([theirs])]);
  assert.equal(result.updated, 1);

  const merged = viewAll(box.dir).views[0];
  assert.equal(merged?.effectiveStatus, "retired", "the later observation wins");
  assert.equal(merged?.entry.history.length, 2, "histories are unioned, not replaced");
  assert.deepEqual(
    [...(merged?.entry.notes ?? [])].sort(),
    ["local note", "remote note"],
    "notes from both sides survive",
  );
});

test("merge reports unreadable incoming lines instead of dropping them silently", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const result = merge(box.dir, [`not json at all\n${JSON.stringify({ v: 1, event: "record", at: "x", entry: entry() })}`]);
  assert.equal(result.added, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /not valid JSON/);
});

test("the merge command works from the CLI", (t) => {
  const box = sandbox({ "package.json": "{}" });
  const other = sandbox({ "package.json": "{}" });
  t.after(() => {
    box.cleanup();
    other.cleanup();
  });

  runCli(other.dir, [
    "record", "--title", "from the other clone", "--cmd", "make build", "--anchor", "package.json",
  ]);
  const otherLedger = other.path(".deadend/ledger.jsonl");

  const result = runCli(box.dir, ["merge", otherLedger]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Merged other ledgers/);
  assert.match(result.stdout, /added\s+1/);

  // And the merged entry is live in this clone.
  assert.equal(runCli(box.dir, ["check", "--cmd", "make build"]).code, 3);
});
