/**
 * The fingerprint must be stable across everything that differs between two
 * runs of the same failure, and different for two different failures. Both
 * halves matter: an over-eager normaliser makes every error look alike, which
 * would make `check` block on unrelated work.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeLine, signature, stripAnsi } from "../src/fingerprint.ts";
import { SHARP_LOG, SHARP_LOG_OTHER_MACHINE } from "./helpers.ts";

test("the same failure on two machines has the same fingerprint", () => {
  assert.equal(
    signature(SHARP_LOG).fingerprint,
    signature(SHARP_LOG_OTHER_MACHINE).fingerprint,
  );
});

test("different failures have different fingerprints", () => {
  const a = signature(SHARP_LOG).fingerprint;
  const b = signature("TypeError: undefined is not a function").fingerprint;
  const c = signature("error TS2304: Cannot find name 'foo'.").fingerprint;
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

test("line and column numbers are not part of the identity", () => {
  const at = (line: string): string => signature(`Error: boom\n    at fn (app.ts:${line})`).fingerprint;
  assert.equal(at("10:5"), at("999:42"));
});

test("absolute paths are reduced to their basename", () => {
  const one = signature("Error: cannot open /Users/a/project/config.json").fingerprint;
  const two = signature("Error: cannot open /home/b/other/config.json").fingerprint;
  assert.equal(one, two);
});

test("durations, digests, uuids and timestamps are erased", () => {
  const one = signature(
    "failed after 3.7s (etag 9f8e7d6c5b4a3f2e1d0c, id 550e8400-e29b-41d4-a716-446655440000) at 2026-09-13T10:11:12Z",
  ).fingerprint;
  const two = signature(
    "failed after 12.1s (etag abcdef0123456789abcd, id 123e4567-e89b-12d3-a456-426614174000) at 2026-10-01T08:00:00Z",
  ).fingerprint;
  assert.equal(one, two);
});

test("error codes survive normalisation, because they are the signal", () => {
  assert.match(normalizeLine("Error: ENOENT no such file", { lower: true }), /enoent/);
  assert.match(normalizeLine("error TS2304: Cannot find name", { lower: true }), /ts2304/);
});

test("case differences in the message do not change the identity", () => {
  assert.equal(
    signature("Error: Cannot Find Module 'x'").fingerprint,
    signature("error: cannot find module 'x'").fingerprint,
  );
});

test("ANSI colour codes are stripped before hashing", () => {
  const plain = "Error: something broke";
  const coloured = "\u001b[31mError: something broke\u001b[0m";
  assert.equal(stripAnsi(coloured), plain);
  assert.equal(signature(coloured).fingerprint, signature(plain).fingerprint);
});

test("progress chatter is skipped in favour of the failure lines", () => {
  const log = [
    "> app@1.0.0 build",
    "> tsc -p .",
    "compiling 412 files",
    "src/index.ts(3,1): error TS2304: Cannot find name 'mystery'.",
    "build finished with 1 error",
  ].join("\n");
  const sig = signature(log);
  assert.ok(sig.keys.some((k) => k.includes("ts2304")), "the TS error should be in the signature");
  assert.ok(!sig.keys.some((k) => k.includes("compiling")), "progress chatter should be dropped");
});

test("output with no error-looking line still produces a signature from its tail", () => {
  const sig = signature("step one\nstep two\nsomething went sideways");
  assert.equal(sig.keys.length, 3, "falls back to the tail rather than producing nothing");
  assert.match(sig.keys.join(" "), /sideways/);
});

test("the excerpt keeps readable case even though the hash is folded", () => {
  const sig = signature("Error: Cannot Find Module 'Sharp'");
  assert.match(sig.excerpt, /Cannot Find Module/);
});

test("an empty log yields an empty signature rather than throwing", () => {
  const sig = signature("");
  assert.deepEqual(sig.keys, []);
  assert.equal(sig.excerpt, "");
});
