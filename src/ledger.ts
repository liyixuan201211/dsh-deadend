/**
 * Reading and writing the ledger.
 *
 * The ledger lives in the repository, at `.deadend/ledger.jsonl`, not in a
 * per-machine cache directory. That is a deliberate design choice with three
 * consequences worth stating plainly:
 *
 *   1. it can be reviewed in a pull request like any other change;
 *   2. a teammate (or a CI job, or your agent on another machine) gets the same
 *      dead ends you do, which is most of the value;
 *   3. it is *yours* — the failure modes your team actually hit, in your repo,
 *      not a global blob you cannot audit.
 *
 * The cost is that it can be committed. That is the point.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DeadEnd, LedgerEvent } from "./model.ts";
import { replay } from "./model.ts";
import { isDir } from "./util.ts";

export const LEDGER_DIR = ".deadend";
export const LEDGER_FILE = "ledger.jsonl";

export const ledgerDir = (root: string): string => join(root, LEDGER_DIR);
export const ledgerPath = (root: string): string => join(root, LEDGER_DIR, LEDGER_FILE);

/**
 * Find the repository root.
 *
 * An existing ledger wins outright (so a nested ledger inside a monorepo
 * package keeps working), otherwise we use the git root, otherwise the current
 * directory.
 */
export function findRoot(start: string = process.cwd()): string {
  const from = resolve(start);
  let dir = from;
  let gitRoot: string | null = null;

  for (;;) {
    if (isDir(join(dir, LEDGER_DIR))) return dir;
    if (gitRoot === null && isDir(join(dir, ".git"))) gitRoot = dir;

    const parent = dirname(dir);
    if (parent === dir) return gitRoot ?? from;
    dir = parent;
  }
}

export function readLedgerLines(root: string): string[] {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n");
}

export interface LedgerState {
  entries: DeadEnd[];
  errors: string[];
}

export const load = (root: string): LedgerState => replay(readLedgerLines(root));

export const findEntry = (root: string, id: string): DeadEnd | undefined =>
  load(root).entries.find((e) => e.id === id || e.id.startsWith(id));

export function append(root: string, event: LedgerEvent): void {
  mkdirSync(ledgerDir(root), { recursive: true });
  appendFileSync(ledgerPath(root), `${JSON.stringify(event)}\n`, "utf8");
}

/** Rewrite the whole ledger, used only by `gc` compaction. */
export function writeAll(root: string, events: LedgerEvent[]): void {
  mkdirSync(ledgerDir(root), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(ledgerPath(root), body.length > 0 ? `${body}\n` : "", "utf8");
}

export interface InitResult {
  root: string;
  created: boolean;
  path: string;
}

/** Create the ledger directory and, when in a git repo, ignore local scratch. */
export function init(root: string): InitResult {
  const dir = ledgerDir(root);
  const created = !isDir(dir);
  mkdirSync(dir, { recursive: true });
  return { root, created, path: ledgerPath(root) };
}
