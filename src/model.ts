/**
 * The data model, and the replay function that turns an append-only event log
 * into current state.
 *
 * The ledger is an event log rather than a mutable document for three reasons:
 * it never needs a read-modify-write cycle (so two agents cannot clobber each
 * other), it diffs cleanly in git, and every status change keeps its reason.
 */

/** `suspect` is derived at read time from anchors; it is never stored. */
export type Status = "active" | "suspect" | "retired";

/**
 * How a dead end can stop being true.
 *
 * `anchored` — it dies when one of its anchors changes (the whole point).
 * `none`     — it cannot decay: a deliberate, loudly-reported escape hatch for
 *              facts with no local artifact to watch (e.g. "the vendor API
 *              rejects this"). Undecayable entries never stop blocking, which
 *              is why `record` refuses to create one by accident.
 */
export type DecayKind = "anchored" | "none";

export interface Anchor {
  /** Repo-relative, posix-separated. */
  path: string;
  /** `sha256:<hex>` of the file, or of a sorted manifest for a directory. */
  hash: string;
  kind: "file" | "dir";
}

/** The result of re-hashing one anchor against the current tree. */
export interface AnchorCheck {
  path: string;
  state: "unchanged" | "changed" | "missing";
  /** The hash recorded when the dead end was written (or last re-confirmed). */
  was: string;
  /** The hash now; null when the path no longer exists. */
  now: string | null;
}

export interface HistoryEntry {
  at: string;
  event: string;
  note: string | null;
}

export interface DeadEnd {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;

  /** The attempt that failed. */
  command: string | null;
  normalized: string | null;
  family: string | null;
  exitCode: number | null;

  /** The failure itself, as a stable signature. */
  fingerprint: string | null;
  excerpt: string | null;

  why: string | null;
  retry: string | null;
  evidence: string[];
  tags: string[];

  anchors: Anchor[];
  decay: DecayKind;

  status: Status;
  retiredAt: string | null;
  retireReason: string | null;

  notes: string[];
  history: HistoryEntry[];
}

export type VerifyOutcome = "still-fails" | "now-works";

export type LedgerEvent =
  | { v: 1; event: "record"; at: string; entry: DeadEnd }
  | {
      v: 1;
      event: "verify";
      at: string;
      id: string;
      outcome: VerifyOutcome;
      anchors: Anchor[] | null;
      note: string | null;
    }
  | { v: 1; event: "note"; at: string; id: string; text: string };

export interface ReplayResult {
  entries: DeadEnd[];
  errors: string[];
}

/**
 * Rebuild current state from ledger lines.
 *
 * Unparseable lines are reported, never silently dropped: a corrupted ledger
 * that quietly forgets dead ends is worse than one that says so.
 */
export function replay(lines: string[]): ReplayResult {
  const map = new Map<string, DeadEnd>();
  const order: string[] = [];
  const errors: string[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let ev: LedgerEvent;
    try {
      ev = JSON.parse(trimmed) as LedgerEvent;
    } catch {
      errors.push(`line ${index + 1}: not valid JSON`);
      return;
    }

    if (ev === null || typeof ev !== "object" || (ev as { v?: unknown }).v !== 1) {
      errors.push(`line ${index + 1}: not a v1 ledger event`);
      return;
    }

    if (ev.event === "record") {
      const entry = ev.entry;
      if (!entry?.id) {
        errors.push(`line ${index + 1}: record event without entry.id`);
        return;
      }
      if (!map.has(entry.id)) order.push(entry.id);
      map.set(entry.id, structuredClone(entry));
      return;
    }

    if (ev.event === "verify") {
      const entry = map.get(ev.id);
      if (!entry) {
        errors.push(`line ${index + 1}: verify for unknown id ${ev.id}`);
        return;
      }
      if (ev.outcome === "now-works") {
        entry.status = "retired";
        entry.retiredAt = ev.at;
        entry.retireReason = ev.note ?? "verified working again";
      } else {
        entry.status = "active";
        entry.retiredAt = null;
        entry.retireReason = null;
        if (ev.anchors) entry.anchors = ev.anchors;
        if (entry.decay === "none" && ev.anchors) entry.decay = "anchored";
      }
      entry.updatedAt = ev.at;
      entry.history.push({ at: ev.at, event: ev.outcome, note: ev.note ?? null });
      return;
    }

    if (ev.event === "note") {
      const entry = map.get(ev.id);
      if (!entry) {
        errors.push(`line ${index + 1}: note for unknown id ${ev.id}`);
        return;
      }
      entry.notes.push(ev.text);
      entry.updatedAt = ev.at;
      entry.history.push({ at: ev.at, event: "note", note: ev.text });
      return;
    }

    errors.push(`line ${index + 1}: unknown event type`);
  });

  const entries = order
    .map((id) => map.get(id))
    .filter((e): e is DeadEnd => e !== undefined);

  return { entries, errors };
}

/**
 * A dead end is stale when at least one anchor no longer matches.
 *
 * `decay: "none"` entries never decay — that is the hazard the tool exists to
 * make visible, not a feature to hide.
 */
export function isDecayed(entry: DeadEnd, checks: AnchorCheck[]): boolean {
  if (entry.decay === "none") return false;
  return checks.some((c) => c.state !== "unchanged");
}
