/**
 * The data model, and the replay function that turns an append-only event log
 * into current state.
 *
 * The ledger is an event log rather than a mutable document for three reasons:
 * it never needs a read-modify-write cycle (so two agents cannot clobber each
 * other), it diffs cleanly in git, and every status change keeps its reason.
 *
 * @typedef {"active" | "suspect" | "retired"} Status
 *
 * @typedef {"anchored" | "none"} DecayKind
 *
 * @typedef {object} Anchor
 * @property {string} path Repo-relative, posix-separated.
 * @property {string} hash `sha256:<hex>` of the file, or of a sorted manifest for a directory.
 * @property {"file" | "dir"} kind
 *
 * @typedef {object} AnchorCheck
 * @property {string} path
 * @property {"unchanged" | "changed" | "missing"} state
 * @property {string} was The hash recorded when the dead end was written (or last re-confirmed).
 * @property {string | null} now The hash now; null when the path no longer exists.
 *
 * @typedef {object} HistoryEntry
 * @property {string} at
 * @property {string} event
 * @property {string | null} note
 *
 * @typedef {object} DeadEnd
 * @property {string} id
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} command
 * @property {string | null} normalized
 * @property {string | null} family
 * @property {number | null} exitCode
 * @property {string | null} fingerprint
 * @property {string | null} excerpt
 * @property {string | null} why
 * @property {string | null} retry
 * @property {string[]} evidence
 * @property {string[]} tags
 * @property {Anchor[]} anchors
 * @property {DecayKind} decay
 * @property {Status} status
 * @property {string | null} retiredAt
 * @property {string | null} retireReason
 * @property {string[]} notes
 * @property {HistoryEntry[]} history
 *
 * @typedef {"still-fails" | "now-works"} VerifyOutcome
 *
 * @typedef {object} RecordEvent
 * @property {1} v
 * @property {"record"} event
 * @property {string} at
 * @property {DeadEnd} entry
 *
 * @typedef {object} VerifyEvent
 * @property {1} v
 * @property {"verify"} event
 * @property {string} at
 * @property {string} id
 * @property {VerifyOutcome} outcome
 * @property {Anchor[] | null} anchors
 * @property {string | null} note
 *
 * @typedef {object} NoteEvent
 * @property {1} v
 * @property {"note"} event
 * @property {string} at
 * @property {string} id
 * @property {string} text
 *
 * @typedef {RecordEvent | VerifyEvent | NoteEvent} LedgerEvent
 *
 * @typedef {object} ReplayResult
 * @property {DeadEnd[]} entries
 * @property {string[]} errors
 */

/**
 * How a dead end can stop being true.
 *
 * `anchored` — it dies when one of its anchors changes (the whole point).
 * `none`     — it cannot decay: a deliberate, loudly-reported escape hatch for
 *              facts with no local artifact to watch (e.g. "the vendor API
 *              rejects this"). Undecayable entries never stop blocking, which
 *              is why `record` refuses to create one by accident.
 */

/**
 * Rebuild current state from ledger lines.
 *
 * Unparseable lines are reported, never silently dropped: a corrupted ledger
 * that quietly forgets dead ends is worse than one that says so.
 *
 * @param {string[]} lines
 * @returns {ReplayResult}
 */
export function replay(lines) {
  /** @type {Map<string, DeadEnd>} */
  const map = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {string[]} */
  const errors = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    /** @type {LedgerEvent} */
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      errors.push(`line ${index + 1}: not valid JSON`);
      return;
    }

    if (ev === null || typeof ev !== "object" || ev.v !== 1) {
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

  const entries = order.map((id) => map.get(id)).filter((e) => e !== undefined);

  return { entries, errors };
}

/**
 * A dead end is stale when at least one anchor no longer matches.
 *
 * `decay: "none"` entries never decay — that is the hazard the tool exists to
 * make visible, not a feature to hide.
 *
 * @param {DeadEnd} entry
 * @param {AnchorCheck[]} checks
 * @returns {boolean}
 */
export function isDecayed(entry, checks) {
  if (entry.decay === "none") return false;
  return checks.some((c) => c.state !== "unchanged");
}
