import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export interface Sandbox {
  dir: string;
  path(rel: string): string;
  write(rel: string, body: string): void;
  rm(rel: string): void;
  cleanup(): void;
}

/**
 * A throwaway directory standing in for a user's repository.
 *
 * No git: `findRoot` falls back to the starting directory, which is exactly the
 * behaviour we want under test, and it keeps the suite fast.
 */
export function sandbox(files: Record<string, string> = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "deadend-test-"));
  const box: Sandbox = {
    dir,
    path: (rel) => join(dir, rel),
    write: (rel, body) => {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    },
    rm: (rel) => rmSync(join(dir, rel), { recursive: true, force: true }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  for (const [rel, body] of Object.entries(files)) box.write(rel, body);
  return box;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(dir: string, args: string[], stdin?: string): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    input: stdin ?? "",
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** A representative failure log, with the usual run-to-run noise in it. */
export const SHARP_LOG = [
  "npm ERR! code 1",
  "npm ERR! path /Users/someone/project/node_modules/sharp",
  "npm ERR! command failed",
  "Error: Cannot find module '/Users/someone/project/node_modules/sharp/build/Release/sharp-darwin-arm64.node'",
  "    at Object..node (node:internal/modules/cjs/loader:1234:18)",
  "npm ERR! A complete log of this run can be found in:",
  "npm ERR!     /Users/someone/.npm/_logs/2026-09-13T10_11_12_345Z-debug-0.log",
  "npm ERR! 3.7s elapsed",
].join("\n");

/** The same failure, seen on another machine, with different noise. */
export const SHARP_LOG_OTHER_MACHINE = [
  "npm ERR! code 1",
  "npm ERR! path /home/ci/runner/work/app/node_modules/sharp",
  "npm ERR! command failed",
  "Error: Cannot find module '/home/ci/runner/work/app/node_modules/sharp/build/Release/sharp-darwin-arm64.node'",
  "    at Object..node (node:internal/modules/cjs/loader:9876:44)",
  "npm ERR! A complete log of this run can be found in:",
  "npm ERR!     /home/ci/.npm/_logs/2026-10-01T08_00_00_000Z-debug-0.log",
  "npm ERR! 12.1s elapsed",
].join("\n");
