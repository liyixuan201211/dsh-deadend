/**
 * The lifecycle, end to end: a dead end that blocks, decays when the code it
 * depended on moves, and stops blocking once re-tested.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { check, gc, record, summarize, verify, viewAll } from "../src/engine.js";
import { signature } from "../src/fingerprint.js";
import { init } from "../src/ledger.js";
import { SHARP_LOG, SHARP_LOG_OTHER_MACHINE, sandbox } from "./helpers.js";

/**
 * @param {import("../src/engine.js").RecordResult} result
 * @returns {import("../src/engine.js").RecordOk}
 */
function mustRecord(result) {
  if (!result.ok) assert.fail(`expected record to succeed, got refusal: ${result.reason}`);
  return result;
}

const base = { title: "npm install sharp fails: no prebuilt binary", command: "npm install sharp" };

test("record refuses an entry with no anchors", (t) => {
  const box = sandbox({ "package.json": "{}", "package-lock.json": "{}" });
  t.after(() => box.cleanup());

  const result = record(box.dir, base);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no-anchors");
  if (result.reason !== "no-anchors") return;
  assert.ok(result.suggestions.includes("package.json"), "should suggest a real manifest");
});

test("record refuses anchors that do not exist", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const result = record(box.dir, { ...base, anchors: ["nope.json"] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "missing-anchors");
});

test("record refuses an empty title", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());
  assert.equal(record(box.dir, { title: "   " }).ok, false);
});

test("a recorded dead end blocks the same command", (t) => {
  const box = sandbox({ "package.json": "{}", "package-lock.json": "{}" });
  t.after(() => box.cleanup());
  init(box.dir);

  mustRecord(
    record(box.dir, {
      ...base,
      logText: SHARP_LOG,
      anchors: ["package.json", "package-lock.json"],
    }),
  );

  const result = check(box.dir, { command: "npm install sharp" });
  assert.equal(result.verdict, "blocked");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.decayed, false);
});

test("wrapper prefixes do not defeat an exact match", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  assert.equal(check(box.dir, { command: "sudo time npm install sharp" }).verdict, "blocked");
});

test("changing an anchor turns the dead end into a suspect, not a clearance", (t) => {
  const box = sandbox({ "package.json": "{}", "package-lock.json": "{}" });
  t.after(() => box.cleanup());

  mustRecord(record(box.dir, { ...base, anchors: ["package.json", "package-lock.json"] }));
  assert.equal(check(box.dir, { command: "npm install sharp" }).verdict, "blocked");

  box.write("package-lock.json", '{"changed":true}');

  const after = check(box.dir, { command: "npm install sharp" });
  assert.equal(after.verdict, "suspect");
  assert.equal(after.matches[0]?.decayed, true);

  const changed = after.matches[0]?.checks.filter((c) => c.state === "changed") ?? [];
  assert.deepEqual(changed.map((c) => c.path), ["package-lock.json"]);
});

test("verify --still-fails re-pins the anchors and blocks again", (t) => {
  const box = sandbox({ "package.json": "{}", "package-lock.json": "{}" });
  t.after(() => box.cleanup());

  const created = mustRecord(
    record(box.dir, { ...base, anchors: ["package.json", "package-lock.json"] }),
  );
  box.write("package-lock.json", '{"changed":true}');
  assert.equal(check(box.dir, { command: base.command }).verdict, "suspect");

  const result = verify(box.dir, created.entry.id, "still-fails", "retested");
  assert.equal(result.ok, true);
  assert.equal(check(box.dir, { command: base.command }).verdict, "blocked");
});

test("verify --now-works retires the entry and clears the command", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const created = mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  verify(box.dir, created.entry.id, "now-works", "fixed upstream");

  assert.equal(check(box.dir, { command: base.command }).verdict, "clear");
  const view = viewAll(box.dir).views.find((v) => v.entry.id === created.entry.id);
  assert.equal(view?.effectiveStatus, "retired");
});

test("verify reports an unknown id instead of silently succeeding", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());
  const result = verify(box.dir, "dd_missing", "now-works", null);
  assert.equal(result.ok, false);
});

test("recording the same dead end twice is refused", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  const again = record(box.dir, { ...base, anchors: ["package.json"] });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.reason, "duplicate");
});

test("a retired dead end that comes back keeps its id and its history", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const created = mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  verify(box.dir, created.entry.id, "now-works", "fixed upstream");

  const recurrence = mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  assert.equal(recurrence.recurrence, true);
  assert.equal(recurrence.entry.id, created.entry.id, "identity is content-derived, so it is stable");
  assert.ok(
    recurrence.entry.history.some((h) => h.event === "now-works"),
    "the earlier retirement must survive in history",
  );
  assert.equal(check(box.dir, { command: base.command }).verdict, "blocked");
});

test("a different command with the same failure output is still caught", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  mustRecord(record(box.dir, { ...base, logText: SHARP_LOG, anchors: ["package.json"] }));

  // Command-based matching cannot see it...
  assert.equal(check(box.dir, { command: "pnpm add sharp" }).verdict, "clear");

  // ...but the signature can, which is the whole point of fingerprinting.
  const bySignature = check(box.dir, {
    command: "pnpm add sharp",
    fingerprint: signature(SHARP_LOG_OTHER_MACHINE).fingerprint,
  });
  assert.equal(bySignature.verdict, "blocked");
  assert.match(bySignature.matches[0]?.reasons.join(" ") ?? "", /identical failure signature/);
});

test("a shared command family is a hint, not a block", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));

  const result = check(box.dir, { command: "npm install left-pad" });
  assert.equal(
    result.verdict,
    "clear",
    "installing a different package is not the same dead end",
  );
  assert.deepEqual(result.matches, [], "nothing decisive should match");
  assert.equal(result.related.length, 1, "but it should be surfaced as related");
  assert.match(result.related[0]?.reasons.join(" ") ?? "", /command family/);
});

test("an unanchored dead end blocks forever", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  mustRecord(
    record(box.dir, {
      title: "vendor API rejects batches over 100 rows",
      command: "curl -X POST /batch",
      unanchored: true,
    }),
  );

  box.write("package.json", '{"completely":"different"}');
  assert.equal(check(box.dir, { command: "curl -X POST /batch" }).verdict, "blocked");
  assert.equal(summarize(box.dir).undecayable, 1);
});

test("identity is content-derived, so two clones agree", (t) => {
  const a = sandbox({ "package.json": "{}" });
  const b = sandbox({ "package.json": "{}" });
  t.after(() => {
    a.cleanup();
    b.cleanup();
  });

  const first = mustRecord(record(a.dir, { ...base, anchors: ["package.json"] }));
  const second = mustRecord(record(b.dir, { ...base, anchors: ["package.json"] }));
  assert.equal(first.entry.id, second.entry.id);
});

test("gc compacts the log without losing entries or history", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const created = mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  verify(box.dir, created.entry.id, "still-fails", "retested");
  const before = viewAll(box.dir).views.length;

  const result = gc(box.dir);
  assert.equal(result.entriesAfter, before);

  const after = viewAll(box.dir);
  assert.equal(after.views.length, before);
  assert.ok(
    after.views[0]?.entry.history.some((h) => h.event === "still-fails"),
    "history must survive compaction",
  );
});

test("gc --drop-retired removes only retired entries", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const keep = mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  const drop = mustRecord(
    record(box.dir, {
      title: "other failure entirely",
      command: "make thing",
      anchors: ["package.json"],
    }),
  );
  verify(box.dir, drop.entry.id, "now-works", null);

  gc(box.dir, { dropRetired: true });

  const ids = viewAll(box.dir).views.map((v) => v.entry.id);
  assert.ok(ids.includes(keep.entry.id));
  assert.ok(!ids.includes(drop.entry.id));
});

test("summarize counts each status", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  mustRecord(record(box.dir, { ...base, anchors: ["package.json"] }));
  const retired = mustRecord(
    record(box.dir, { title: "unrelated", command: "go build", anchors: ["package.json"] }),
  );
  verify(box.dir, retired.entry.id, "now-works", null);

  const summary = summarize(box.dir);
  assert.equal(summary.total, 2);
  assert.equal(summary.active, 1);
  assert.equal(summary.retired, 1);
  assert.equal(summary.suspect, 0);
});

test("check on an empty ledger is clear and says so", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());
  const result = check(box.dir, { command: "npm test" });
  assert.equal(result.verdict, "clear");
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.related, []);
});
