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
import { check, record, type CheckQuery, type CheckResult, type RecordInput, type RecordResult } from "./engine.ts";
import { signature } from "./fingerprint.ts";

export * from "./model.ts";
export * from "./fingerprint.ts";
export * from "./anchors.ts";
export * from "./ledger.ts";
export * from "./engine.ts";
export * from "./util.ts";

export interface Attempt {
  /** The shell command you are about to run. */
  command?: string | undefined;
  /** Output from a previous run of it, if you have one. */
  logText?: string | undefined;
  /** A short description, when there is no command. */
  title?: string | undefined;
}

export interface Advice {
  verdict: CheckResult["verdict"];
  /** One line an agent can act on directly. */
  advice: string;
  result: CheckResult;
}

/**
 * Ask the ledger whether an attempt has already been ruled out.
 *
 * Never mutates: asking is always safe, which is what makes it reasonable to
 * put in front of every attempt.
 */
export function lookBeforeYouLeap(root: string, attempt: Attempt): Advice {
  const query: CheckQuery = {
    command: attempt.command,
    title: attempt.title,
    fingerprint: attempt.logText ? signature(attempt.logText).fingerprint : undefined,
  };

  const result = check(root, query);

  let advice: string;
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

/** Record a dead end. Thin wrapper over `record` with the log turned into a signature. */
export function noteDeadEnd(root: string, input: RecordInput): RecordResult {
  return record(root, input);
}
