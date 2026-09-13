/**
 * The CLI's contract. Exit codes are the interface an agent or a CI gate
 * actually depends on, so they are asserted explicitly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli, sandbox } from "./helpers.ts";

const FILES = { "package.json": '{"name":"demo"}', "package-lock.json": "{}" };

test("--version and --help succeed", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());
  assert.equal(runCli(box.dir, ["--version"]).code, 0);
  const help = runCli(box.dir, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /deadend — remember what did not work/);
});

test("an unknown command is a usage error", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());
  assert.equal(runCli(box.dir, ["explode"]).code, 2);
});

test("an unknown option is a usage error", (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());
  assert.equal(runCli(box.dir, ["list", "--nonsense"]).code, 2);
});

test("init creates the ledger", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  const result = runCli(box.dir, ["init"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\.deadend\/ledger\.jsonl/);
});

test("check on an empty ledger exits 0 and says CLEAR", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  const result = runCli(box.dir, ["check", "--cmd", "npm test"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CLEAR/);
});

test("check with no query at all is a usage error", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  assert.equal(runCli(box.dir, ["check"]).code, 2);
});

test("check --json emits parseable JSON", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  const result = runCli(box.dir, ["check", "--cmd", "npm test", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout) as { verdict: string };
  assert.equal(parsed.verdict, "clear");
});

test("the full gate: blocked (3), suspect (4), clear (0)", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());

  const recorded = runCli(box.dir, [
    "record",
    "--title", "npm install sharp fails",
    "--cmd", "npm install sharp",
    "--symptom", "Error: Cannot find module sharp-darwin-arm64.node",
    "--anchor", "package.json",
    "--anchor", "package-lock.json",
  ]);
  assert.equal(recorded.code, 0);

  // Authoritative -> blocked.
  const blocked = runCli(box.dir, ["check", "--cmd", "npm install sharp"]);
  assert.equal(blocked.code, 3);
  assert.match(blocked.stdout, /BLOCKED/);

  // The world moves -> suspect, and the changed anchor is named.
  box.write("package-lock.json", '{"changed":true}');
  const suspect = runCli(box.dir, ["check", "--cmd", "npm install sharp"]);
  assert.equal(suspect.code, 4);
  assert.match(suspect.stdout, /SUSPECT/);
  assert.match(suspect.stdout, /package-lock\.json/);

  // Re-tested and fixed -> clear.
  const retired = runCli(box.dir, ["verify", "dd_", "--now-works"]);
  assert.equal(retired.code, 0);
  assert.equal(runCli(box.dir, ["check", "--cmd", "npm install sharp"]).code, 0);
});

test("--quiet prints nothing but still reports through the exit code", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());

  runCli(box.dir, [
    "record", "--title", "t", "--cmd", "make build", "--anchor", "package.json",
  ]);

  const quiet = runCli(box.dir, ["check", "--cmd", "make build", "--quiet"]);
  assert.equal(quiet.code, 3);
  assert.equal(quiet.stdout, "", "quiet must print nothing");

  const short = runCli(box.dir, ["check", "--cmd", "make build", "-q"]);
  assert.equal(short.code, 3);
  assert.equal(short.stdout, "");
});

test("recording without anchors is refused with exit 5", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  const result = runCli(box.dir, ["record", "--title", "mystery failure"]);
  assert.equal(result.code, 5);
  assert.match(result.stdout, /Refusing to record/);
  assert.match(result.stdout, /--anchor package\.json/);
});

test("recording a duplicate is refused with exit 5", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  const args = ["record", "--title", "t", "--cmd", "make build", "--anchor", "package.json"];
  assert.equal(runCli(box.dir, args).code, 0);
  const again = runCli(box.dir, args);
  assert.equal(again.code, 5);
  assert.match(again.stdout, /Already recorded/);
});

test("record needs a title", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  assert.equal(runCli(box.dir, ["record", "--cmd", "make"]).code, 2);
});

test("verify needs exactly one outcome flag", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  runCli(box.dir, ["record", "--title", "t", "--cmd", "make", "--anchor", "package.json"]);

  assert.equal(runCli(box.dir, ["verify", "dd_"]).code, 2);
  assert.equal(runCli(box.dir, ["verify", "dd_", "--still-fails", "--now-works"]).code, 2);
});

test("verify reports an unknown id with a non-zero exit", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  assert.notEqual(runCli(box.dir, ["verify", "dd_nope", "--now-works"]).code, 0);
});

test("list, status and show all work on a populated ledger", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  runCli(box.dir, ["record", "--title", "make build fails", "--cmd", "make build", "--anchor", "package.json"]);

  const list = runCli(box.dir, ["list"]);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /make build/);

  const json = runCli(box.dir, ["list", "--json"]);
  const parsed = JSON.parse(json.stdout) as Array<{ title: string; status: string }>;
  assert.equal(parsed[0]?.status, "active");

  const status = runCli(box.dir, ["status"]);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /entries\s+1/);

  const id = /dd_[0-9a-f]+/.exec(list.stdout)?.[0];
  assert.ok(id, "list should print an id");
  const show = runCli(box.dir, ["show", id]);
  assert.equal(show.code, 0);
  assert.match(show.stdout, /make build/);

  assert.notEqual(runCli(box.dir, ["show", "dd_missing"]).code, 0);
});

test("gc reports what it did", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());
  runCli(box.dir, ["record", "--title", "t", "--cmd", "make build", "--anchor", "package.json"]);

  const dry = runCli(box.dir, ["gc", "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /Would compact/);

  const real = runCli(box.dir, ["gc"]);
  assert.equal(real.code, 0);
  assert.match(real.stdout, /Compacted/);
});

test("a failure log on stdin is matched by signature", (t) => {
  const box = sandbox(FILES);
  t.after(() => box.cleanup());

  const log = "Error: Cannot find module 'left-pad'\n    at app.ts:3:1";
  runCli(box.dir, [
    "record", "--title", "left-pad missing", "--cmd", "npm test",
    "--symptom", log, "--anchor", "package.json",
  ]);

  // A different command, the same failure, fed in on stdin.
  const result = runCli(box.dir, ["check", "--cmd", "vitest run", "--log", "-"], log);
  assert.equal(result.code, 3, "the signature should still match");
});
