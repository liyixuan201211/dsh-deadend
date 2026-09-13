/**
 * The ledger engine: recording, checking, verifying and compacting.
 *
 * The three operations map onto the three moments that matter:
 *
 *   record — something failed in a way worth not repeating
 *   check  — about to try something; has this already been ruled out?
 *   verify — a suspect was re-tested; it either still fails or it now works
 *
 * `check` never mutates anything. Its only job is to answer honestly, and its
 * answer has three possible shapes: blocked, suspect, or clear.
 */
import { statSync } from "node:fs";

import { evaluateAnchors, hashPath, hasDecayed, suggestAnchors } from "./anchors.js";
import { signature } from "./fingerprint.js";
import { append, load, ledgerPath, writeAll } from "./ledger.js";
import { commandFamily, jaccard, normalizeCommand, nowIso, sha256, tokenize } from "./util.js";

/**
 * @typedef {import("./model.js").Anchor} Anchor
 * @typedef {import("./model.js").AnchorCheck} AnchorCheck
 * @typedef {import("./model.js").DeadEnd} DeadEnd
 * @typedef {import("./model.js").LedgerEvent} LedgerEvent
 * @typedef {import("./model.js").Status} Status
 * @typedef {import("./model.js").VerifyOutcome} VerifyOutcome
 */

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

/**
 * A dead end plus its freshly-evaluated decay state.
 *
 * @typedef {object} EntryView
 * @property {DeadEnd} entry
 * @property {AnchorCheck[]} checks
 * @property {boolean} decayed
 * @property {Status} effectiveStatus `suspect` is computed here; the stored status is only ever active/retired.
 */

/**
 * @param {DeadEnd} entry
 * @param {boolean} decayed
 * @returns {Status}
 */
export function effectiveStatus(entry, decayed) {
  if (entry.status === "retired") return "retired";
  return decayed ? "suspect" : "active";
}

/**
 * @param {string} root
 * @returns {{ views: EntryView[], errors: string[] }}
 */
export function viewAll(root) {
  const { entries, errors } = load(root);
  const views = entries.map((entry) => {
    const checks = evaluateAnchors(root, entry);
    const decayed = hasDecayed(root, entry, checks);
    return { entry, checks, decayed, effectiveStatus: effectiveStatus(entry, decayed) };
  });
  return { views, errors };
}

/* ------------------------------------------------------------------ *
 * check
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} CheckQuery
 * @property {string} [command]
 * @property {string} [fingerprint]
 * @property {string} [title]
 *
 * @typedef {object} Match
 * @property {DeadEnd} entry
 * @property {number} strength 3 = same failure signature, 2 = same command, 1 = same family / similar.
 * @property {string[]} reasons
 * @property {AnchorCheck[]} checks
 * @property {boolean} decayed
 * @property {boolean} blocking Whether this match may change the verdict.
 *
 * @typedef {"clear" | "blocked" | "suspect"} Verdict
 *
 * @typedef {object} CheckResult
 * @property {Verdict} verdict
 * @property {Match[]} matches Decisive matches (strength >= 2). These are what the verdict is made of.
 * @property {Match[]} related Weak hints (strength 1). Reported, but they never change the verdict.
 * @property {{ command: string | null, fingerprint: string | null, title: string | null }} query
 * @property {string[]} errors
 */

/**
 * Match a proposed attempt against the ledger.
 *
 * Matching is layered by confidence. A matching *signature* is the strongest
 * evidence (the same failure text was seen before, whatever the command
 * looked like); an identical normalised command is next; a shared command
 * family or a similar title is a weak hint worth surfacing but not worth
 * blocking on.
 *
 * Only strength >= 2 is decisive. A shared command *family* — "you once had
 * trouble with `npm install`" — is a hint worth showing and not worth blocking
 * on: `npm install sharp` failing says nothing about `npm install left-pad`.
 * Blocking there would be false confidence, and false confidence is how a gate
 * like this gets switched off.
 *
 * @param {string} root
 * @param {CheckQuery} query
 * @returns {CheckResult}
 */
export function check(root, query) {
  const { entries, errors } = load(root);

  const normalized = query.command ? normalizeCommand(query.command) : null;
  const family = query.command ? commandFamily(query.command) : null;
  const titleTokens = query.title ? tokenize(query.title) : [];

  /** @type {Match[]} */
  const matches = [];

  for (const entry of entries) {
    if (entry.status === "retired") continue;

    let strength = 0;
    /** @type {string[]} */
    const reasons = [];

    if (query.fingerprint && entry.fingerprint && entry.fingerprint === query.fingerprint) {
      strength = Math.max(strength, 3);
      reasons.push("identical failure signature");
    }

    if (normalized && entry.normalized) {
      if (entry.normalized === normalized) {
        strength = Math.max(strength, 2);
        reasons.push("identical command");
      } else if (family && entry.family && entry.family === family) {
        strength = Math.max(strength, 1);
        reasons.push(`same command family (${family})`);
      }
    }

    if (strength === 0 && titleTokens.length > 0) {
      const overlap = jaccard(titleTokens, tokenize(entry.title));
      if (overlap >= 0.5) {
        strength = 1;
        reasons.push("similar description");
      }
    }

    if (strength === 0) continue;

    const checks = evaluateAnchors(root, entry);
    matches.push({
      entry,
      strength,
      reasons,
      checks,
      decayed: hasDecayed(root, entry, checks),
      blocking: strength >= 2,
    });
  }

  matches.sort(
    (a, b) => b.strength - a.strength || a.entry.createdAt.localeCompare(b.entry.createdAt),
  );

  const decisive = matches.filter((m) => m.blocking);
  const related = matches.filter((m) => !m.blocking);

  // A single still-authoritative dead end is enough to block. Suspects never
  // block — they are a prompt to re-test, not a prohibition.
  /** @type {Verdict} */
  const verdict = decisive.some((m) => !m.decayed)
    ? "blocked"
    : decisive.some((m) => m.decayed)
      ? "suspect"
      : "clear";

  return {
    verdict,
    matches: decisive,
    related,
    query: {
      command: query.command ?? null,
      fingerprint: query.fingerprint ?? null,
      title: query.title ?? null,
    },
    errors,
  };
}

/* ------------------------------------------------------------------ *
 * record
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} RecordInput
 * @property {string} title
 * @property {string | null} [command]
 * @property {number | null} [exitCode]
 * @property {string | null} [logText]
 * @property {string | null} [why]
 * @property {string | null} [retry]
 * @property {string[]} [evidence]
 * @property {string[]} [tags]
 * @property {string[]} [anchors]
 * @property {boolean} [unanchored]
 * @property {boolean} [force]
 *
 * @typedef {{ ok: true, entry: DeadEnd, recurrence: boolean }} RecordOk
 * @typedef {{ ok: false, reason: "empty-title" }} RecordEmptyTitle
 * @typedef {{ ok: false, reason: "no-anchors", suggestions: string[] }} RecordNoAnchors
 * @typedef {{ ok: false, reason: "missing-anchors", missing: string[] }} RecordMissingAnchors
 * @typedef {{ ok: false, reason: "duplicate", existing: DeadEnd }} RecordDuplicate
 * @typedef {RecordOk | RecordEmptyTitle | RecordNoAnchors | RecordMissingAnchors | RecordDuplicate} RecordResult
 */

/**
 * Identity is derived from the content of the claim, not from a counter or a
 * random id. Two teammates who record the same dead end independently produce
 * the same id, so merging ledgers is a union rather than a de-duplication
 * problem.
 *
 * @param {{ title: string, normalized: string | null, fingerprint: string | null, anchorPaths: string[] }} input
 * @returns {string}
 */
function identify(input) {
  const key = [
    input.title.trim().toLowerCase(),
    input.normalized ?? "",
    input.fingerprint ?? "",
    [...input.anchorPaths].sort().join(","),
  ].join("|");
  return `dd_${sha256(key).slice(0, 12)}`;
}

/**
 * @param {string} root
 * @param {RecordInput} input
 * @returns {RecordResult}
 */
export function record(root, input) {
  const title = input.title.trim();
  if (!title) return { ok: false, reason: "empty-title" };

  const requested = (input.anchors ?? []).map((p) => p.trim()).filter(Boolean);

  // The discipline that makes the tool worth having: a dead end with nothing to
  // watch can never expire, and an expiry-proof block is indistinguishable
  // from a bug. So we refuse to create one silently.
  if (!input.unanchored && requested.length === 0) {
    return {
      ok: false,
      reason: "no-anchors",
      suggestions: suggestAnchors(root, input.command ?? null),
    };
  }

  /** @type {Anchor[]} */
  const anchors = [];
  /** @type {string[]} */
  const missing = [];
  for (const path of requested) {
    const anchor = hashPath(root, path);
    if (anchor) anchors.push(anchor);
    else missing.push(path);
  }
  if (missing.length > 0) return { ok: false, reason: "missing-anchors", missing };

  const normalized = input.command ? normalizeCommand(input.command) : null;
  const family = input.command ? commandFamily(input.command) : null;
  const symptom = input.logText ? signature(input.logText) : null;
  const at = nowIso();

  const id = identify({
    title,
    normalized,
    fingerprint: symptom?.fingerprint ?? null,
    anchorPaths: anchors.map((a) => a.path),
  });

  const existing = load(root).entries.find((e) => e.id === id);

  if (existing && existing.status !== "retired" && !input.force) {
    return { ok: false, reason: "duplicate", existing };
  }

  /** @type {DeadEnd} */
  const entry = {
    id,
    title,
    createdAt: at,
    updatedAt: at,
    command: input.command ?? null,
    normalized,
    family,
    exitCode: input.exitCode ?? null,
    fingerprint: symptom?.fingerprint ?? null,
    excerpt: symptom?.excerpt ?? null,
    why: input.why ?? null,
    retry: input.retry ?? null,
    evidence: input.evidence ?? [],
    tags: input.tags ?? [],
    anchors,
    decay: input.unanchored || anchors.length === 0 ? "none" : "anchored",
    status: "active",
    retiredAt: null,
    retireReason: null,
    notes: [],
    // Carrying history across a recurrence keeps the audit trail: this id was
    // once believed fixed and came back.
    history: existing?.history ? [...existing.history] : [],
  };

  if (existing) {
    entry.notes.push(`re-recorded ${at} (the failure came back)`);
    entry.history.push({ at, event: "re-record", note: "failure recurred" });
  }

  append(root, { v: 1, event: "record", at, entry });

  return { ok: true, entry, recurrence: Boolean(existing) };
}

/* ------------------------------------------------------------------ *
 * verify
 * ------------------------------------------------------------------ */

/**
 * @typedef {{ ok: true, entry: DeadEnd, outcome: VerifyOutcome, anchors: Anchor[] }} VerifyOk
 * @typedef {{ ok: false, reason: "not-found", id: string }} VerifyNotFound
 * @typedef {VerifyOk | VerifyNotFound} VerifyResult
 */

/**
 * Re-test outcome, applied to the ledger.
 *
 * `still-fails` re-pins the anchors to the current tree, which is what makes a
 * suspect authoritative again: the claim has been re-observed against the
 * world as it is now.
 *
 * @param {string} root
 * @param {string} id
 * @param {VerifyOutcome} outcome
 * @param {string | null} note
 * @returns {VerifyResult}
 */
export function verify(root, id, outcome, note) {
  const { entries } = load(root);
  const entry = entries.find((e) => e.id === id || e.id.startsWith(id));
  if (!entry) return { ok: false, reason: "not-found", id };

  const at = nowIso();
  const anchors =
    outcome === "still-fails"
      ? entry.anchors.map((a) => hashPath(root, a.path)).filter((a) => a !== null)
      : [];

  append(root, { v: 1, event: "verify", at, id: entry.id, outcome, anchors, note });

  const updated = load(root).entries.find((e) => e.id === entry.id) ?? entry;
  return { ok: true, entry: updated, outcome, anchors };
}

/* ------------------------------------------------------------------ *
 * gc
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} GcOptions
 * @property {boolean} [dropRetired]
 * @property {boolean} [dropUndecayable]
 *
 * @typedef {object} GcResult
 * @property {true} ok
 * @property {number} entriesBefore
 * @property {number} entriesAfter
 * @property {number} dropped
 * @property {number} bytesBefore
 * @property {number} bytesAfter
 * @property {boolean} dryRun
 * @property {number} undecayable
 */

/**
 * @param {string} path
 * @returns {number}
 */
function readBytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Compact the event log to one record per entry.
 *
 * Replay already accumulates history into the entry, so a compacted ledger
 * keeps every observation while shedding the intermediate events that produced
 * them.
 *
 * @param {string} root
 * @param {GcOptions} [options]
 * @param {boolean} [dryRun]
 * @returns {GcResult}
 */
export function gc(root, options = {}, dryRun = false) {
  const { views } = viewAll(root);
  const path = ledgerPath(root);
  const before = views.length;

  const keep = views.filter((v) => {
    if (options.dropRetired && v.effectiveStatus === "retired") return false;
    if (options.dropUndecayable && v.entry.decay === "none") return false;
    return true;
  });

  /** @type {LedgerEvent[]} */
  const events = keep.map((v) => ({
    v: 1,
    event: "record",
    at: v.entry.createdAt,
    entry: v.entry,
  }));

  const bytesBefore = readBytes(path);
  if (!dryRun) {
    writeAll(root, events);
  }

  return {
    ok: true,
    entriesBefore: before,
    entriesAfter: keep.length,
    dropped: before - keep.length,
    bytesBefore,
    bytesAfter: dryRun ? bytesBefore : readBytes(path),
    dryRun,
    undecayable: keep.filter((v) => v.entry.decay === "none").length,
  };
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} StatusSummary
 * @property {string} root
 * @property {string} ledger
 * @property {number} total
 * @property {number} active
 * @property {number} suspect
 * @property {number} retired
 * @property {number} undecayable
 * @property {string | null} oldest
 * @property {string | null} newest
 * @property {string[]} errors
 */

/**
 * @param {string} root
 * @returns {StatusSummary}
 */
export function summarize(root) {
  const { views, errors } = viewAll(root);
  /** @param {EntryView} v @returns {string} */
  const at = (v) => v.entry.updatedAt || v.entry.createdAt;
  const times = views.map(at).sort();

  return {
    root,
    ledger: ledgerPath(root),
    total: views.length,
    active: views.filter((v) => v.effectiveStatus === "active").length,
    suspect: views.filter((v) => v.effectiveStatus === "suspect").length,
    retired: views.filter((v) => v.effectiveStatus === "retired").length,
    undecayable: views.filter((v) => v.entry.decay === "none").length,
    oldest: times[0] ?? null,
    newest: times[times.length - 1] ?? null,
    errors,
  };
}
