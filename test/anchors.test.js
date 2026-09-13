/**
 * Anchors decide whether a dead end still applies, so their behaviour is the
 * most consequential thing in the codebase.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkAnchor,
  evaluateAnchors,
  hashPath,
  hasDecayed,
  suggestAnchors,
} from "../src/anchors.js";
import { sandbox } from "./helpers.js";

/**
 * @param {import("../src/model.js").Anchor[]} anchors
 * @returns {import("../src/model.js").DeadEnd}
 */
const entryWith = (anchors) => ({
  id: "dd_test",
  title: "t",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  command: null,
  normalized: null,
  family: null,
  exitCode: null,
  fingerprint: null,
  excerpt: null,
  why: null,
  retry: null,
  evidence: [],
  tags: [],
  anchors,
  decay: anchors.length > 0 ? "anchored" : "none",
  status: "active",
  retiredAt: null,
  retireReason: null,
  notes: [],
  history: [],
});

test("a file anchor is unchanged until its content changes", (t) => {
  const box = sandbox({ "package.json": '{"name":"a"}' });
  t.after(() => box.cleanup());

  const anchor = hashPath(box.dir, "package.json");
  assert.ok(anchor, "should hash an existing file");
  assert.equal(checkAnchor(box.dir, anchor).state, "unchanged");

  box.write("package.json", '{"name":"b"}');
  assert.equal(checkAnchor(box.dir, anchor).state, "changed");
});

test("touching a file without changing content does not invalidate an anchor", (t) => {
  const box = sandbox({ "a.txt": "same" });
  t.after(() => box.cleanup());

  const anchor = hashPath(box.dir, "a.txt");
  assert.ok(anchor);

  box.write("a.txt", "same");
  assert.equal(checkAnchor(box.dir, anchor).state, "unchanged");
});

test("deleting an anchor is a change, not a pass", (t) => {
  const box = sandbox({ "a.txt": "content" });
  t.after(() => box.cleanup());

  const anchor = hashPath(box.dir, "a.txt");
  assert.ok(anchor);

  box.rm("a.txt");
  assert.equal(checkAnchor(box.dir, anchor).state, "missing");
});

test("a directory anchor notices a file added underneath it", (t) => {
  const box = sandbox({ "config/base.json": "{}" });
  t.after(() => box.cleanup());

  const anchor = hashPath(box.dir, "config");
  assert.ok(anchor);
  assert.equal(anchor.kind, "dir");

  box.write("config/extra.json", "{}");
  assert.equal(checkAnchor(box.dir, anchor).state, "changed");
});

test("a directory anchor notices a file edited underneath it", (t) => {
  const box = sandbox({ "config/base.json": "{}" });
  t.after(() => box.cleanup());

  const anchor = hashPath(box.dir, "config");
  assert.ok(anchor);

  box.write("config/base.json", '{"changed":true}');
  assert.equal(checkAnchor(box.dir, anchor).state, "changed");
});

test("hashing a path that does not exist returns null", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());
  assert.equal(hashPath(box.dir, "nope.txt"), null);
});

test("an entry whose anchors all match has not decayed", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const anchor = hashPath(box.dir, "package.json");
  assert.ok(anchor);
  const entry = entryWith([anchor]);
  assert.equal(hasDecayed(box.dir, entry, evaluateAnchors(box.dir, entry)), false);

  box.write("package.json", '{"x":1}');
  assert.equal(hasDecayed(box.dir, entry, evaluateAnchors(box.dir, entry)), true);
});

test("an entry with no anchors can never decay — the hazard, not a feature", (t) => {
  const box = sandbox({ "package.json": "{}" });
  t.after(() => box.cleanup());

  const entry = entryWith([]);
  assert.equal(entry.decay, "none");
  box.write("package.json", '{"x":1}');
  assert.equal(hasDecayed(box.dir, entry, evaluateAnchors(box.dir, entry)), false);
});

test("anchor suggestions come from the command and only name real files", (t) => {
  const box = sandbox({ "package.json": "{}", "package-lock.json": "{}" });
  t.after(() => box.cleanup());

  const forNpm = suggestAnchors(box.dir, "npm install sharp");
  assert.ok(forNpm.includes("package.json"));
  assert.ok(forNpm.includes("package-lock.json"));
  assert.ok(!forNpm.includes("yarn.lock"), "should not suggest files that do not exist");

  const forCargo = suggestAnchors(box.dir, "cargo build");
  assert.ok(!forCargo.includes("Cargo.toml"), "no Cargo.toml here, so it must not be suggested");
});
