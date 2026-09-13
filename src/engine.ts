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

import {
  evaluateAnchors,
  hashPath,
  hasDecayed,
  suggestAnchors,
} from "./anchors.ts";
import { signature } from "./fingerprint.ts";
import { append, load, ledgerPath, writeAll } from "./ledger.ts";
import type {
  Anchor,
  AnchorCheck,
  DeadEnd,
  LedgerEvent,
  Status,
  VerifyOutcome,
} from "./model.ts";
import {
  commandFamily,
  jaccard,
  normalizeCommand,
  nowIso,
  sha256,
  tokenize,
} from "./util.ts";

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

/** A dead end plus its freshly-evaluated decay state. */
export interface EntryView {
  entry: DeadEnd;
  checks: AnchorCheck[];
  decayed: boolean;
  /** `suspect` is computed here; the stored status is only ever active/retired. */
  effectiveStatus: Status;
}

export function effectiveStatus(entry: DeadEnd, decayed: boolean): Status {
  if (entry.status === "retired") return "retired";
  return decayed ? "suspect" : "active";
}

export function viewAll(root: string): { views: EntryView[]; errors: string[] } {
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

export interface CheckQuery {
  command?: string | undefined;
  fingerprint?: string | undefined;
  title?: string | undefined;
}

export interface Match {
  entry: DeadEnd;
  /** 3 = same failure signature, 2 = same command, 1 = same family / similar. */
  strength: number;
  reasons: string[];
  checks: AnchorCheck[];
  decayed: boolean;
  /**
   * Whether this match may change the verdict.
   *
   * Only strength >= 2 is decisive. A shared command *family* — "you once had
   * trouble with `npm install`" — is a hint worth showing and not worth
   * blocking on: `npm install sharp` failing says nothing about
   * `npm install left-pad`. Blocking there would be false confidence, and false
   * confidence is how a gate like this gets switched off.
   */
  blocking: boolean;
}

export type Verdict = "clear" | "blocked" | "suspect";

export interface CheckResult {
  verdict: Verdict;
  /** Decisive matches (strength >= 2). These are what the verdict is made of. */
  matches: Match[];
  /** Weak hints (strength 1). Reported, but they never change the verdict. */
  related: Match[];
  query: { command: string | null; fingerprint: string | null; title: string | null };
  errors: string[];
}

/**
 * Match a proposed attempt against the ledger.
 *
 * Matching is layered by confidence. A matching *signature* is the strongest
 * evidence (the same failure text was seen before, whatever the command
 * looked like); an identical normalised command is next; a shared command
 * family or a similar title is a weak hint worth surfacing but not worth
 * blocking on.
 */
export function check(root: string, query: CheckQuery): CheckResult {
  const { entries, errors } = load(root);

  const normalized = query.command ? normalizeCommand(query.command) : null;
  const family = query.command ? commandFamily(query.command) : null;
  const titleTokens = query.title ? tokenize(query.title) : [];

  const matches: Match[] = [];

  for (const entry of entries) {
    if (entry.status === "retired") continue;

    let strength = 0;
    const reasons: string[] = [];

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
  const verdict: Verdict = decisive.some((m) => !m.decayed)
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

export interface RecordInput {
  title: string;
  command?: string | null;
  exitCode?: number | null;
  logText?: string | null;
  why?: string | null;
  retry?: string | null;
  evidence?: string[];
  tags?: string[];
  anchors?: string[];
  unanchored?: boolean;
  force?: boolean;
}

export type RecordResult =
  | { ok: true; entry: DeadEnd; recurrence: boolean }
  | { ok: false; reason: "empty-title" }
  | { ok: false; reason: "no-anchors"; suggestions: string[] }
  | { ok: false; reason: "missing-anchors"; missing: string[] }
  | { ok: false; reason: "duplicate"; existing: DeadEnd };

/**
 * Identity is derived from the content of the claim, not from a counter or a
 * random id. Two teammates who record the same dead end independently produce
 * the same id, so merging ledgers is a union rather than a de-duplication
 * problem.
 */
function identify(input: {
  title: string;
  normalized: string | null;
  fingerprint: string | null;
  anchorPaths: string[];
}): string {
  const key = [
    input.title.trim().toLowerCase(),
    input.normalized ?? "",
    input.fingerprint ?? "",
    [...input.anchorPaths].sort().join(","),
  ].join("|");
  return `dd_${sha256(key).slice(0, 12)}`;
}

export function record(root: string, input: RecordInput): RecordResult {
  const title = input.title.trim();
  if (!title) return { ok: false, reason: "empty-title" };

  const requested = (input.anchors ?? []).map((p) => p.trim()).filter(Boolean);

  // The discipline that makes the tool worth having: a dead end with nothing to
  // watch can never expire, and an expired-proof block is indistinguishable
  // from a bug. So we refuse to create one silently.
  if (!input.unanchored && requested.length === 0) {
    return { ok: false, reason: "no-anchors", suggestions: suggestAnchors(root, input.command ?? null) };
  }

  const anchors: Anchor[] = [];
  const missing: string[] = [];
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

  const entry: DeadEnd = {
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

export type VerifyResult =
  | { ok: true; entry: DeadEnd; outcome: VerifyOutcome; anchors: Anchor[] }
  | { ok: false; reason: "not-found"; id: string };

/**
 * Re-test outcome, applied to the ledger.
 *
 * `still-fails` re-pins the anchors to the current tree, which is what makes a
 * suspect authoritative again: the claim has been re-observed against the
 * world as it is now.
 */
export function verify(
  root: string,
  id: string,
  outcome: VerifyOutcome,
  note: string | null,
): VerifyResult {
  const { entries } = load(root);
  const entry = entries.find((e) => e.id === id || e.id.startsWith(id));
  if (!entry) return { ok: false, reason: "not-found", id };

  const at = nowIso();
  const anchors =
    outcome === "still-fails"
      ? entry.anchors
          .map((a) => hashPath(root, a.path))
          .filter((a): a is Anchor => a !== null)
      : [];

  append(root, { v: 1, event: "verify", at, id: entry.id, outcome, anchors, note });

  const updated = load(root).entries.find((e) => e.id === entry.id) ?? entry;
  return { ok: true, entry: updated, outcome, anchors };
}

/* ------------------------------------------------------------------ *
 * gc
 * ------------------------------------------------------------------ */

export interface GcOptions {
  dropRetired?: boolean;
  dropUndecayable?: boolean;
}

export interface GcResult {
  ok: true;
  entriesBefore: number;
  entriesAfter: number;
  dropped: number;
  bytesBefore: number;
  bytesAfter: number;
  dryRun: boolean;
  undecayable: number;
}

/**
 * Compact the event log to one record per entry.
 *
 * Replay already accumulates history into the entry, so a compacted ledger
 * keeps every observation while shedding the intermediate events that produced
 * them.
 */
export function gc(root: string, options: GcOptions = {}, dryRun = false): GcResult {
  const { views } = viewAll(root);
  const path = ledgerPath(root);
  const before = views.length;

  const keep = views.filter((v) => {
    if (options.dropRetired && v.effectiveStatus === "retired") return false;
    if (options.dropUndecayable && v.entry.decay === "none") return false;
    return true;
  });

  const events: LedgerEvent[] = keep.map((v) => ({
    v: 1 as const,
    event: "record" as const,
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

function readBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

export interface StatusSummary {
  root: string;
  ledger: string;
  total: number;
  active: number;
  suspect: number;
  retired: number;
  undecayable: number;
  oldest: string | null;
  newest: string | null;
  errors: string[];
}

export function summarize(root: string): StatusSummary {
  const { views, errors } = viewAll(root);
  const at = (v: EntryView): string => v.entry.updatedAt || v.entry.createdAt;
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
