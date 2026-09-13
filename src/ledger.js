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

import { replay } from "./model.js";
import { isDir } from "./util.js";

/**
 * @typedef {import("./model.js").DeadEnd} DeadEnd
 * @typedef {import("./model.js").LedgerEvent} LedgerEvent
 * @typedef {import("./model.js").ReplayResult} ReplayResult
 */

export const LEDGER_DIR = ".deadend";
export const LEDGER_FILE = "ledger.jsonl";

/**
 * @param {string} root
 * @returns {string}
 */
export const ledgerDir = (root) => join(root, LEDGER_DIR);

/**
 * @param {string} root
 * @returns {string}
 */
export const ledgerPath = (root) => join(root, LEDGER_DIR, LEDGER_FILE);

/**
 * Find the repository root.
 *
 * An existing ledger wins outright (so a nested ledger inside a monorepo
 * package keeps working), otherwise we use the git root, otherwise the current
 * directory.
 *
 * @param {string} [start]
 * @returns {string}
 */
export function findRoot(start = process.cwd()) {
  const from = resolve(start);
  let dir = from;
  /** @type {string | null} */
  let gitRoot = null;

  for (;;) {
    if (isDir(join(dir, LEDGER_DIR))) return dir;
    if (gitRoot === null && isDir(join(dir, ".git"))) gitRoot = dir;

    const parent = dirname(dir);
    if (parent === dir) return gitRoot ?? from;
    dir = parent;
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function readLedgerLines(root) {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n");
}

/**
 * @param {string} root
 * @returns {ReplayResult}
 */
export const load = (root) => replay(readLedgerLines(root));

/**
 * @param {string} root
 * @param {string} id
 * @returns {DeadEnd | undefined}
 */
export const findEntry = (root, id) =>
  load(root).entries.find((e) => e.id === id || e.id.startsWith(id));

/**
 * @param {string} root
 * @param {LedgerEvent} event
 * @returns {void}
 */
export function append(root, event) {
  mkdirSync(ledgerDir(root), { recursive: true });
  appendFileSync(ledgerPath(root), `${JSON.stringify(event)}\n`, "utf8");
}

/**
 * Rewrite the whole ledger, used only by `gc` compaction.
 *
 * @param {string} root
 * @param {LedgerEvent[]} events
 * @returns {void}
 */
export function writeAll(root, events) {
  mkdirSync(ledgerDir(root), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(ledgerPath(root), body.length > 0 ? `${body}\n` : "", "utf8");
}

/**
 * @typedef {object} InitResult
 * @property {string} root
 * @property {boolean} created
 * @property {string} path
 */

/**
 * Create the ledger directory.
 *
 * @param {string} root
 * @returns {InitResult}
 */
export function init(root) {
  const dir = ledgerDir(root);
  const created = !isDir(dir);
  mkdirSync(dir, { recursive: true });
  return { root, created, path: ledgerPath(root) };
}
