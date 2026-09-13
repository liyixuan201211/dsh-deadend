/**
 * Anchors: the mechanism that lets a dead end expire.
 *
 * An anchor is a path whose *content* the recorded failure depended on. At
 * record time we store its hash; at read time we recompute it. If any anchor
 * changed, the dead end is no longer authoritative — it becomes a *suspect*,
 * which means "worth re-testing", not "true".
 *
 * This is the difference between this tool and a registry that expires by
 * wall-clock age. A time-based rule is wrong in both directions:
 *
 *   - too slow: a dependency bump that invalidates a dead end this morning does
 *     not clear it, because the entry is still 12 days "young";
 *   - too fast: a dead end about a frozen, vendored dependency is dismissed
 *     after 60 days even though nothing about it changed.
 *
 * Content is the thing that actually determines whether a failure still
 * applies, so content is what we watch.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isDir, isFile, sha256, toPosix } from "./util.js";

/** Directories that are never interesting and ruinously expensive to hash. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".deadend", "dist", "build", "out", "target",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".mypy_cache",
  ".pytest_cache", ".turbo", ".cache", "coverage", ".DS_Store", "vendor",
]);

/** Guard against pathological trees. */
const MAX_WALK_DEPTH = 12;
const MAX_MANIFEST_FILES = 5000;

/**
 * @typedef {import("./model.js").Anchor} Anchor
 * @typedef {import("./model.js").AnchorCheck} AnchorCheck
 * @typedef {import("./model.js").DeadEnd} DeadEnd
 */

/**
 * List files under `rel` using git when possible.
 *
 * git is both faster and more correct than a hand-rolled walk: it already knows
 * about .gitignore, so we never hash a build directory the user has excluded.
 * Returns null when git cannot answer, and the caller falls back to a walk.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {string[] | null}
 */
function gitListFiles(root, rel) {
  const result = spawnSync("git", ["ls-files", "-z", "--", rel], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  const files = result.stdout.split("\0").filter(Boolean);
  // `git ls-files -- <rel>` still lists from the repo root; keep only what is
  // actually underneath the anchor path.
  const prefix = toPosix(rel).replace(/\/+$/, "");
  return files.filter((f) => f === prefix || f.startsWith(`${prefix}/`));
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string[]} out
 * @param {number} depth
 * @returns {void}
 */
function walkFiles(root, rel, out, depth) {
  if (depth > MAX_WALK_DEPTH || out.length > MAX_MANIFEST_FILES) return;
  const abs = join(root, rel);
  if (isFile(abs)) {
    out.push(toPosix(rel));
    return;
  }
  if (!isDir(abs)) return;
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    walkFiles(root, join(rel, name), out, depth + 1);
  }
}

/**
 * Hash a path into an anchor. Returns null when the path does not exist — you
 * cannot anchor to nothing, and letting it slide would create a record that
 * silently never decays.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {Anchor | null}
 */
export function hashPath(root, rel) {
  const clean = toPosix(rel).replace(/^\.\//, "").replace(/\/+$/, "");
  const abs = join(root, clean);

  if (isFile(abs)) {
    return { path: clean, hash: `sha256:${sha256(readFileSync(abs))}`, kind: "file" };
  }

  if (isDir(abs)) {
    const listed = gitListFiles(root, clean) ?? [];
    let candidates = listed;
    if (candidates.length === 0) {
      /** @type {string[]} */
      const walked = [];
      walkFiles(root, clean, walked, 0);
      candidates = walked;
    }

    const files = candidates
      .filter((f) => isFile(join(root, f)))
      .sort()
      .slice(0, MAX_MANIFEST_FILES);

    const manifest = files
      .map((f) => `${f} ${sha256(readFileSync(join(root, f)))}`)
      .join("\n");

    return { path: clean, hash: `sha256:${sha256(manifest)}`, kind: "dir" };
  }

  return null;
}

/**
 * Recompute one anchor against the current tree.
 *
 * @param {string} root
 * @param {Anchor} anchor
 * @returns {AnchorCheck}
 */
export function checkAnchor(root, anchor) {
  const now = hashPath(root, anchor.path);
  if (!now) return { path: anchor.path, state: "missing", was: anchor.hash, now: null };
  if (now.hash === anchor.hash) {
    return { path: anchor.path, state: "unchanged", was: anchor.hash, now: now.hash };
  }
  return { path: anchor.path, state: "changed", was: anchor.hash, now: now.hash };
}

/**
 * @param {string} root
 * @param {DeadEnd} entry
 * @returns {AnchorCheck[]}
 */
export const evaluateAnchors = (root, entry) =>
  entry.anchors.map((a) => checkAnchor(root, a));

/**
 * True when the recorded world no longer matches the current one.
 *
 * @param {string} root
 * @param {DeadEnd} entry
 * @param {AnchorCheck[]} [checks]
 * @returns {boolean}
 */
export function hasDecayed(root, entry, checks) {
  if (entry.decay === "none") return false;
  const result = checks ?? evaluateAnchors(root, entry);
  return result.some((c) => c.state !== "unchanged");
}

/**
 * Anchors to propose when the user did not name any.
 *
 * This is what makes the discipline affordable. Enforcing "every dead end must
 * be falsifiable" is only reasonable if the tool does the work of finding the
 * falsifier, so `record` suggests the lockfiles and manifests that the failed
 * command almost certainly read.
 *
 * @type {Array<[RegExp, string[]]>}
 */
const ANCHOR_RECIPES = [
  [/\b(npm|npx|yarn|pnpm|bun|node)\b/, ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]],
  [/\b(tsc|vitest|jest|vite|eslint|prettier|webpack|rollup|esbuild)\b/, ["package.json", "tsconfig.json"]],
  [/\b(python3?|pip3?|pytest|uv|poetry|ruff|mypy|tox)\b/, ["pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock", "setup.py"]],
  [/\bcargo\b/, ["Cargo.toml", "Cargo.lock"]],
  [/\bgo\b/, ["go.mod", "go.sum"]],
  [/\b(docker|docker-compose|docker compose)\b/, ["Dockerfile", "docker-compose.yml", "compose.yaml"]],
  [/\b(make|cmake)\b/, ["Makefile", "CMakeLists.txt"]],
  [/\b(terraform|tofu)\b/, ["main.tf", "terraform.tfvars"]],
  [/\b(gradle|gradlew)\b/, ["build.gradle", "build.gradle.kts", "settings.gradle"]],
  [/\bmvn\b/, ["pom.xml"]],
  [/\bswift\b/, ["Package.swift", "Package.resolved"]],
  [/\b(ruby|bundle|gem)\b/, ["Gemfile", "Gemfile.lock"]],
  [/\b(flutter|dart)\b/, ["pubspec.yaml", "pubspec.lock"]],
];

/**
 * @param {string} root
 * @param {string | null} command
 * @returns {string[]}
 */
export function suggestAnchors(root, command) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} p */
  const consider = (p) => {
    if (out.includes(p)) return;
    if (isFile(join(root, p)) || isDir(join(root, p))) out.push(p);
  };

  if (command) {
    for (const [pattern, paths] of ANCHOR_RECIPES) {
      if (pattern.test(command)) paths.forEach(consider);
    }
  }

  if (out.length === 0) {
    for (const p of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile"]) {
      consider(p);
    }
  }

  return out;
}
