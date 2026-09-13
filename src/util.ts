/**
 * Small shared helpers: hashing, paths, time and shell-command normalisation.
 *
 * Nothing here touches the ledger; this module is pure so it can be unit-tested
 * without a filesystem fixture beyond what each test creates for itself.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const sha256 = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");

export const shortHash = (text: string, length = 12): string => sha256(text).slice(0, length);

export const nowIso = (): string => new Date().toISOString();

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readText(p: string): string {
  return readFileSync(p, "utf8");
}

export const toPosix = (p: string): string => p.split(sep).join("/");

/** Path relative to `root`, always posix-separated. */
export function relTo(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  return toPosix(relative(root, abs));
}

export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

export function ageInDays(iso: string, from: Date = new Date()): number | null {
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
 */
export function normalizeCommand(command: string): string {
  let c = collapse(command);
  while (WRAPPERS.test(c)) c = c.replace(WRAPPERS, "");
  return collapse(c);
}

/** Coarse bucket for a command: `npm install`, `git push`, `pytest`, … */
export function commandFamily(command: string): string {
  const parts = normalizeCommand(command).split(" ").filter(Boolean);
  const first = parts[0] ?? "";
  const base = first.split("/").pop() ?? first;
  if (MULTI_COMMAND.has(base)) {
    const second = parts[1];
    if (second && !second.startsWith("-")) return `${base} ${second}`;
  }
  return base;
}

/** Word tokens used for fuzzy title comparison. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2);
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const w of sa) if (sb.has(w)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
