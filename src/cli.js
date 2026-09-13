#!/usr/bin/env node
/**
 * deadend — a ledger of failures you have already ruled out.
 *
 * Exit codes are part of the interface, because the useful place to run
 * `check` is in front of the command you were about to run:
 *
 *   0  clear     nothing known against this attempt
 *   1  error     unexpected failure
 *   2  usage     bad invocation
 *   3  blocked   a recorded dead end matches and is still authoritative
 *   4  suspect   a recorded dead end matches, but its anchors changed
 *   5  refused   the ledger declined to record (no anchors, or duplicate)
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";

import { check, gc, record, summarize, viewAll, verify } from "./engine.js";
import { signature } from "./fingerprint.js";
import { findRoot, init, ledgerPath } from "./ledger.js";
import {
  renderCheck,
  renderGc,
  renderList,
  renderRecord,
  renderShow,
  renderStatus,
  renderVerify,
} from "./report.js";
import { toPosix } from "./util.js";

export const VERSION = "1.0.0";

const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  blocked: 3,
  suspect: 4,
  refused: 5,
};

/**
 * The option surface this file reads. Declared as a record type rather than a
 * list of `@property` tags because several CLI flags contain dashes, which
 * `@property` cannot express.
 *
 * @typedef {{
 *   help?: boolean, version?: boolean, json?: boolean, quiet?: boolean,
 *   title?: string, cmd?: string, exit?: string, log?: string,
 *   symptom?: string, why?: string, retry?: string,
 *   anchor?: string[], evidence?: string[], tag?: string[],
 *   unanchored?: boolean, force?: boolean,
 *   "still-fails"?: boolean, "now-works"?: boolean, note?: string,
 *   status?: string, all?: boolean,
 *   "drop-retired"?: boolean, "drop-undecayable"?: boolean, "dry-run"?: boolean,
 * }} CliValues
 */

/** @type {import("node:util").ParseArgsOptionsConfig} */
const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },

  title: { type: "string", short: "t" },
  cmd: { type: "string" },
  exit: { type: "string" },
  log: { type: "string" },
  symptom: { type: "string" },
  why: { type: "string" },
  retry: { type: "string" },
  anchor: { type: "string", multiple: true },
  evidence: { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  unanchored: { type: "boolean" },
  force: { type: "boolean" },

  "still-fails": { type: "boolean" },
  "now-works": { type: "boolean" },
  note: { type: "string" },

  status: { type: "string" },
  all: { type: "boolean" },

  "drop-retired": { type: "boolean" },
  "drop-undecayable": { type: "boolean" },
  "dry-run": { type: "boolean" },
};

const HELP = `deadend — remember what did not work, so it costs you once.

Usage: deadend <command> [options]

  check     Should I try this? Exits 3 if a recorded dead end still applies,
            exits 4 if it applies but its anchors changed.
              --cmd <shell command>      what you are about to run
              --log <file|->             failure output to match by signature
              --symptom <text>           failure text inline
              --title <text>             free-text description to compare
              -q, --quiet                print nothing, exit code only

  record    Record a failure worth not repeating.
              -t, --title <text>         what failed (required)
              --cmd <shell command>      the attempt that failed
              --exit <n>                 its exit code
              --log <file|->             its output (drives the signature)
              --symptom <text>           failure text inline
              --why <text>               why it failed
              --retry <text>             what to do instead
              --anchor <path>            a file/dir whose change invalidates this
                                         (repeatable; suggested if omitted)
              --unanchored               accept an entry that can never expire
              --evidence <ref>           log path, URL, issue (repeatable)
              --tag <tag>                label (repeatable)
              --force                    record even if it looks like a duplicate

  verify    Record the result of re-testing a suspect.
              deadend verify <id> --still-fails [--log <file>] [--note <text>]
              deadend verify <id> --now-works   [--note <text>]

  list      List recorded dead ends.        --status active|suspect|retired
  show      Full detail for one entry.      deadend show <id>
  status    Ledger summary, including entries that can never expire.
  init      Create .deadend/ in this repo.
  gc        Compact the event log.          --dry-run --drop-retired

Global: --json (machine-readable), -h/--help, --version

The ledger is .deadend/ledger.jsonl, inside your repo, so it can be reviewed,
shared and committed. Entries expire when an anchor's content changes — not
when a clock says so.
`;

/** @returns {string} */
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve the failure text a command was given, from any of the three sources.
 *
 * @param {{ log?: string, symptom?: string }} values
 * @returns {string | null}
 */
function resolveLogText(values) {
  if (values.symptom !== undefined) return values.symptom;
  if (values.log === undefined) return null;
  if (values.log === "-") return readStdin();
  try {
    return readFileSync(values.log, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {string}
 */
const ledgerDisplay = (root) => toPosix(relative(root, ledgerPath(root)));

class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return command === undefined ? EXIT.usage : EXIT.ok;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`deadend ${VERSION}\n`);
    return EXIT.ok;
  }

  const parsed = parseArgs({
    args: rest,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  // parseArgs can only describe its values as a union of every option type.
  // The shape below is the contract this file actually reads; the cast is
  // routed through `unknown` because it is a narrowing of an opaque record,
  // not a claim that the two types are related.
  const values = /** @type {CliValues} */ (/** @type {unknown} */ (parsed.values));
  const positionals = parsed.positionals;

  if (values.version) {
    process.stdout.write(`deadend ${VERSION}\n`);
    return EXIT.ok;
  }

  const root = findRoot();
  const json = values.json === true;

  switch (command) {
    case "init": {
      const result = init(root);
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return EXIT.ok;
      }
      process.stdout.write(
        `${result.created ? "Created" : "Already present"}: ${ledgerDisplay(root)}\n` +
          "\nCommit this file. It is the point of the tool: the next session, your\n" +
          "teammates and CI all inherit what you already ruled out.\n",
      );
      return EXIT.ok;
    }

    case "record": {
      const title = values.title ?? positionals.join(" ");
      if (!title.trim()) throw new UsageError("record needs a title: --title <text>");

      const logText = resolveLogText(values);
      const exitCode = values.exit === undefined ? null : Number.parseInt(values.exit, 10);

      const result = record(root, {
        title,
        command: values.cmd ?? null,
        exitCode: exitCode !== null && Number.isFinite(exitCode) ? exitCode : null,
        logText,
        why: values.why ?? null,
        retry: values.retry ?? null,
        evidence: values.evidence ?? [],
        tags: values.tag ?? [],
        anchors: values.anchor ?? [],
        unanchored: values.unanchored === true,
        force: values.force === true,
      });

      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.ok ? EXIT.ok : EXIT.refused;
      }
      process.stdout.write(renderRecord(result, ledgerDisplay(root)));
      return result.ok ? EXIT.ok : EXIT.refused;
    }

    case "check": {
      const logText = resolveLogText(values);
      const commandQuery = values.cmd ?? positionals.join(" ");
      if (!commandQuery && !logText && !values.title) {
        throw new UsageError("check needs at least one of --cmd, --log/--symptom or --title");
      }

      const result = check(root, {
        command: commandQuery || undefined,
        fingerprint: logText ? signature(logText).fingerprint : undefined,
        title: values.title ?? undefined,
      });

      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (values.quiet !== true) {
        process.stdout.write(renderCheck(result));
      }

      if (result.verdict === "blocked") return EXIT.blocked;
      if (result.verdict === "suspect") return EXIT.suspect;
      return EXIT.ok;
    }

    case "list": {
      const { views, errors } = viewAll(root);
      let filtered = views;
      if (values.status !== undefined) {
        const wanted = values.status;
        filtered = views.filter((v) => v.effectiveStatus === wanted);
      } else if (values.all !== true) {
        filtered = views.filter((v) => v.effectiveStatus !== "retired");
      }
      filtered = [...filtered].sort((a, b) =>
        b.entry.createdAt.localeCompare(a.entry.createdAt),
      );

      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            filtered.map((v) => ({
              id: v.entry.id,
              title: v.entry.title,
              status: v.effectiveStatus,
              decay: v.entry.decay,
              createdAt: v.entry.createdAt,
              anchors: v.checks.map((c) => ({ path: c.path, state: c.state })),
            })),
            null,
            2,
          )}\n`,
        );
        return EXIT.ok;
      }
      process.stdout.write(renderList(filtered, views));
      if (errors.length > 0) {
        process.stderr.write(`⚠ ${errors.length} unreadable ledger line(s)\n`);
      }
      return EXIT.ok;
    }

    case "show": {
      const id = positionals[0];
      if (!id) throw new UsageError("show needs an id: deadend show <id>");
      const { views } = viewAll(root);
      const view = views.find((v) => v.entry.id === id || v.entry.id.startsWith(id));
      if (!view) {
        process.stderr.write(`No dead end matches "${id}".\n`);
        return EXIT.error;
      }
      if (json) {
        process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
        return EXIT.ok;
      }
      process.stdout.write(renderShow(view));
      return EXIT.ok;
    }

    case "verify": {
      const id = positionals[0];
      if (!id) throw new UsageError("verify needs an id: deadend verify <id> --still-fails|--now-works");

      const stillFails = values["still-fails"] === true;
      const nowWorks = values["now-works"] === true;
      if (stillFails === nowWorks) {
        throw new UsageError("verify needs exactly one of --still-fails or --now-works");
      }

      const logText = resolveLogText(values);
      let note = values.note ?? null;
      if (stillFails && logText) {
        const sig = signature(logText);
        const short = sig.fingerprint.slice(7, 19);
        note = note === null ? `signature ${short}` : `${note} (signature ${short})`;
      }

      const result = verify(root, id, stillFails ? "still-fails" : "now-works", note);

      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.ok ? EXIT.ok : EXIT.error;
      }
      process.stdout.write(renderVerify(result));
      return result.ok ? EXIT.ok : EXIT.error;
    }

    case "status": {
      const summary = summarize(root);
      if (json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return EXIT.ok;
      }
      process.stdout.write(renderStatus(summary));
      return EXIT.ok;
    }

    case "gc": {
      const result = gc(
        root,
        {
          dropRetired: values["drop-retired"] === true,
          dropUndecayable: values["drop-undecayable"] === true,
        },
        values["dry-run"] === true,
      );
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return EXIT.ok;
      }
      process.stdout.write(renderGc(result));
      return EXIT.ok;
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return EXIT.usage;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (error instanceof UsageError || code.startsWith("ERR_PARSE_ARGS")) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.usage;
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = EXIT.error;
  }
}
