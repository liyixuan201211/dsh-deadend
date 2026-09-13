/**
 * Programmatic API.
 *
 * The CLI is the primary interface — it is what the skill tells an agent to
 * run — but the engine is usable as a library so a harness, a CI job or a hook
 * can consult the ledger without shelling out.
 *
 * The two functions worth knowing:
 *
 *   lookBeforeYouLeap(root, { command, logText })
 *     -> { verdict, advice } ; `verdict` is "clear" | "blocked" | "suspect"
 *
 *   noteDeadEnd(root, { title, command, logText, anchors, ... })
 *     -> the recorded entry, or a refusal explaining what is missing
 */
import { check, record } from "./engine.js";
import { signature } from "./fingerprint.js";

// Canonical types live in model.js and are re-exported wholesale.
//
// Everything else is re-exported *by name*. `export *` would collide: each
// module declares JSDoc `@typedef` aliases of the model types, and TypeScript
// treats those aliases as exports, so a wildcard re-export of two modules that
// both alias `DeadEnd` is an ambiguity error rather than a silent override.
export * from "./model.js";
export * from "./fingerprint.js";
export * from "./util.js";

export {
  checkAnchor,
  evaluateAnchors,
  hashPath,
  hasDecayed,
  suggestAnchors,
} from "./anchors.js";

export {
  LEDGER_DIR,
  LEDGER_FILE,
  append,
  findEntry,
  findRoot,
  init,
  ledgerDir,
  ledgerPath,
  load,
  readLedgerLines,
  writeAll,
} from "./ledger.js";

export {
  check,
  effectiveStatus,
  gc,
  record,
  summarize,
  verify,
  viewAll,
} from "./engine.js";

/**
 * @typedef {object} Attempt
 * @property {string} [command] The shell command you are about to run.
 * @property {string} [logText] Output from a previous run of it, if you have one.
 * @property {string} [title] A short description, when there is no command.
 *
 * @typedef {object} Advice
 * @property {import("./engine.js").Verdict} verdict
 * @property {string} advice One line an agent can act on directly.
 * @property {import("./engine.js").CheckResult} result
 */

/**
 * Ask the ledger whether an attempt has already been ruled out.
 *
 * Never mutates: asking is always safe, which is what makes it reasonable to
 * put in front of every attempt.
 *
 * @param {string} root
 * @param {Attempt} attempt
 * @returns {Advice}
 */
export function lookBeforeYouLeap(root, attempt) {
  const result = check(root, {
    command: attempt.command,
    title: attempt.title,
    fingerprint: attempt.logText ? signature(attempt.logText).fingerprint : undefined,
  });

  /** @type {string} */
  let advice;
  if (result.verdict === "blocked") {
    const ids = result.matches.filter((m) => !m.decayed).map((m) => m.entry.id);
    advice = `Already ruled out (${ids.join(", ")}). Read those entries before retrying; they carry the evidence.`;
  } else if (result.verdict === "suspect") {
    const ids = result.matches.filter((m) => m.decayed).map((m) => m.entry.id);
    advice = `Recorded before but its anchors changed (${ids.join(", ")}). It may work now — re-test and then run \`deadend verify\`.`;
  } else {
    advice = "Nothing known against this attempt.";
  }

  return { verdict: result.verdict, advice, result };
}

/**
 * Record a dead end.
 *
 * @param {string} root
 * @param {import("./engine.js").RecordInput} input
 * @returns {import("./engine.js").RecordResult}
 */
export function noteDeadEnd(root, input) {
  return record(root, input);
}
