/**
 * Small shared helpers: hashing, paths, time and shell-command normalisation.
 *
 * Plain JavaScript with JSDoc types, deliberately: Node refuses to strip types
 * for files inside `node_modules`, so a `.ts` entry point cannot run once the
 * package is actually installed. Shipping `.js` keeps the no-build-step promise
 * *and* works when installed.
 *
 * Nothing here touches the ledger; this module is pure so it can be unit-tested
 * without a filesystem fixture beyond what each test creates for itself.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * @param {string | Buffer} text
 * @returns {string}
 */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * @param {string} text
 * @param {number} [length]
 * @returns {string}
 */
export const shortHash = (text, length = 12) => sha256(text).slice(0, length);

/** @returns {string} */
export const nowIso = () => new Date().toISOString();

/**
 * @param {string} p
 * @returns {boolean}
 */
export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {string}
 */
export function readText(p) {
  return readFileSync(p, "utf8");
}

/**
 * @param {string} p
 * @returns {string}
 */
export const toPosix = (p) => p.split(sep).join("/");

/**
 * Path relative to `root`, always posix-separated.
 *
 * @param {string} root
 * @param {string} p
 * @returns {string}
 */
export function relTo(root, p) {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  return toPosix(relative(root, abs));
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function truncate(s, max) {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * @param {string} s
 * @returns {string}
 */
export const collapse = (s) => s.replace(/\s+/g, " ").trim();

/**
 * @param {string} iso
 * @param {Date} [from]
 * @returns {number | null}
 */
export function ageInDays(iso, from = new Date()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((from.getTime() - t) / 86_400_000);
}

/** Tools whose first argument is a subcommand worth keeping in the "family". */
const MULTI_COMMAND = new Set([
  "npm", "yarn", "pnpm", "bun", "git", "cargo", "go", "docker", "docker-compose",
  "kubectl", "dotnet", "pip", "pip3", "uv", "poetry", "make", "gradle", "mvn",
  "terraform", "tofu", "gh", "dsh", "deno",
]);

/** Leading wrappers that never change *what* actually failed. */
const WRAPPERS = /^(?:sudo|time|command|nohup|env)\s+/;

/**
 * Collapse a shell command to a comparable form.
 *
 * Deliberately conservative: we drop wrappers and squeeze whitespace, but we do
 * not rewrite the command. Two commands that differ in flags are still
 * different commands, and pretending otherwise would make `check` lie.
 *
 * @param {string} command
 * @returns {string}
 */
export function normalizeCommand(command) {
  let c = collapse(command);
  while (WRAPPERS.test(c)) c = c.replace(WRAPPERS, "");
  return collapse(c);
}

/**
 * Coarse bucket for a command: `npm install`, `git push`, `pytest`, …
 *
 * @param {string} command
 * @returns {string}
 */
export function commandFamily(command) {
  const parts = normalizeCommand(command).split(" ").filter(Boolean);
  const first = parts[0] ?? "";
  const base = first.split("/").pop() ?? first;
  if (MULTI_COMMAND.has(base)) {
    const second = parts[1];
    if (second && !second.startsWith("-")) return `${base} ${second}`;
  }
  return base;
}

/**
 * Word tokens used for fuzzy title comparison.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2);
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const w of sa) if (sb.has(w)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
