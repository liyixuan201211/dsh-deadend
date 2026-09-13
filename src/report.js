/**
 * Rendering.
 *
 * The reader of this output is usually an agent deciding what to do next, so
 * the format optimises for one thing: making the *reason* a dead end blocks
 * legible, and making the escape hatch (re-test) obvious. A verdict without its
 * evidence just teaches an agent to route around the tool.
 */
import { ageInDays, plural } from "./util.js";

/**
 * @typedef {import("./engine.js").CheckResult} CheckResult
 * @typedef {import("./engine.js").EntryView} EntryView
 * @typedef {import("./engine.js").GcResult} GcResult
 * @typedef {import("./engine.js").Match} Match
 * @typedef {import("./engine.js").RecordResult} RecordResult
 * @typedef {import("./engine.js").StatusSummary} StatusSummary
 * @typedef {import("./engine.js").VerifyResult} VerifyResult
 * @typedef {import("./model.js").AnchorCheck} AnchorCheck
 */

/**
 * @param {string | null} hash
 * @returns {string}
 */
export const shortDigest = (hash) =>
  hash === null ? "missing" : hash.replace(/^sha256:/, "").slice(0, 8);

/**
 * @param {string} iso
 * @returns {string}
 */
const ago = (iso) => {
  const days = ageInDays(iso);
  if (days === null) return iso;
  if (days <= 0) return "today";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};

/** @returns {string} */
const rule = () => "─".repeat(72);

/**
 * @param {AnchorCheck} check
 * @returns {string}
 */
function anchorLine(check) {
  if (check.state === "unchanged") return `      ✓ ${check.path}`;
  if (check.state === "missing") return `      ✗ ${check.path}  (deleted since recording)`;
  return `      ✗ ${check.path}  ${shortDigest(check.was)} → ${shortDigest(check.now)}`;
}

/**
 * @param {AnchorCheck[]} check
 * @returns {string}
 */
function anchorSummary(check) {
  const changed = check.filter((c) => c.state !== "unchanged").length;
  if (check.length === 0) return "no anchors — this can never expire";
  if (changed === 0) return `${check.length} of ${check.length} unchanged — still authoritative`;
  return `${changed} of ${check.length} changed — no longer authoritative`;
}

/**
 * @param {string} iso
 * @returns {string}
 */
function fullDate(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * One dead end, in full, with the anchors that decide its fate.
 *
 * @param {Match} match
 * @returns {string[]}
 */
export function renderMatch(match) {
  const e = match.entry;
  /** @type {string[]} */
  const lines = [];

  lines.push(`${e.id}  ${e.title}`);
  lines.push(`    matched   ${match.reasons.join("; ")}`);
  lines.push(`    recorded  ${fullDate(e.createdAt)} (${ago(e.createdAt)})`);

  if (e.command) {
    const exit = e.exitCode === null ? "" : `  →  exit ${e.exitCode}`;
    lines.push(`    attempt   ${e.command}${exit}`);
  }
  if (e.excerpt) lines.push(`    symptom   ${e.excerpt}`);
  if (e.why) lines.push(`    why       ${e.why}`);
  if (e.retry) lines.push(`    instead   ${e.retry}`);

  lines.push(`    anchors   ${anchorSummary(match.checks)}`);
  for (const check of match.checks) lines.push(anchorLine(check));

  if (e.evidence.length > 0) lines.push(`    evidence  ${e.evidence.join(", ")}`);
  if (e.tags.length > 0) lines.push(`    tags      ${e.tags.join(", ")}`);

  return lines;
}

/**
 * @param {CheckResult} result
 * @returns {string}
 */
export function renderCheck(result) {
  /** @type {string[]} */
  const out = [];
  const blocking = result.matches.filter((m) => !m.decayed);
  const suspects = result.matches.filter((m) => m.decayed);

  if (result.verdict === "clear") {
    out.push("✓ CLEAR — nothing in the ledger rules this attempt out.");
    out.push("");
    out.push("That is not a guarantee it will work, only that you have not already");
    out.push("ruled it out here.");

    if (result.related.length > 0) {
      out.push("");
      out.push(
        `Related, not blocking (${plural(result.related.length, "entry", "entries")} ` +
          "in the same area — a shared command family or a similar description):",
      );
      for (const m of result.related) {
        out.push(`  ${m.entry.id}  ${m.entry.title}`);
        out.push(`      ${m.reasons.join("; ")}`);
        if (m.entry.retry) out.push(`      last time: ${m.entry.retry}`);
      }
    }
  } else if (result.verdict === "blocked") {
    out.push(
      `⛔ BLOCKED — ${plural(blocking.length, "recorded dead end")} matches, and ` +
        `${blocking.length === 1 ? "its anchors are" : "their anchors are"} unchanged.`,
    );
    out.push("");
    out.push(rule());
    blocking.forEach((m, i) => {
      if (i > 0) out.push(rule());
      out.push(...renderMatch(m));
    });
    out.push(rule());
    out.push("");
    out.push("This is not a prohibition — it is a claim that was true, with its evidence.");
    out.push("If you think the world moved, re-test it and re-confirm:");
    for (const m of blocking) {
      out.push(`  deadend verify ${m.entry.id} --still-fails --log <new-output>`);
    }
  } else {
    out.push(
      `⚠ SUSPECT — ${plural(suspects.length, "recorded dead end")} matches, but the world ` +
        `it described has changed.`,
    );
    out.push("");
    out.push(rule());
    suspects.forEach((m, i) => {
      if (i > 0) out.push(rule());
      out.push(...renderMatch(m));
    });
    out.push(rule());
    out.push("");
    out.push("Re-test it: it may now work.");
    for (const m of suspects) {
      out.push(`  still fails?  deadend verify ${m.entry.id} --still-fails`);
      out.push(`  works now?    deadend verify ${m.entry.id} --now-works`);
    }
  }

  if (result.errors.length > 0) {
    out.push("");
    out.push(`⚠ ${plural(result.errors.length, "ledger line")} could not be read:`);
    for (const err of result.errors.slice(0, 5)) out.push(`    ${err}`);
  }

  return `${out.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */

/**
 * @param {EntryView[]} rows
 * @param {EntryView[]} [all]
 * @returns {string}
 */
export function renderList(rows, all = rows) {
  if (all.length === 0) {
    return "No dead ends recorded yet. Run `deadend record` after a failure worth not repeating.\n";
  }

  /** @type {string[]} */
  const out = [];
  const counts = {
    active: all.filter((v) => v.effectiveStatus === "active").length,
    suspect: all.filter((v) => v.effectiveStatus === "suspect").length,
    retired: all.filter((v) => v.effectiveStatus === "retired").length,
  };
  out.push(`${counts.active} active · ${counts.suspect} suspect · ${counts.retired} retired`);
  if (rows.length !== all.length) {
    out.push(`showing ${rows.length} of ${all.length}`);
  }
  out.push("");

  if (rows.length === 0) {
    out.push("Nothing matches that filter.");
    return `${out.join("\n")}\n`;
  }

  const labelWidth = Math.max(...rows.map((v) => v.effectiveStatus.length));
  const idWidth = Math.max(...rows.map((v) => v.entry.id.length));

  for (const view of rows) {
    const why =
      view.effectiveStatus === "suspect"
        ? `(${view.checks
            .filter((c) => c.state !== "unchanged")
            .map((c) => c.path)
            .join(", ")} changed)`
        : view.entry.decay === "none"
          ? "(no anchors — can never expire)"
          : `(${plural(view.checks.length, "anchor")} ok)`;

    out.push(
      [
        view.effectiveStatus.toUpperCase().padEnd(labelWidth),
        view.entry.id.padEnd(idWidth),
        `${fullDate(view.entry.createdAt)}  ${view.entry.title}`,
        why,
      ].join("  "),
    );
  }

  return `${out.join("\n")}\n`;
}

/**
 * @param {EntryView} view
 * @returns {string}
 */
export function renderShow(view) {
  /** @type {string[]} */
  const out = [];
  const { entry } = view;

  out.push(`${entry.id}  ${entry.title}`);
  out.push(`    status    ${view.effectiveStatus}`);
  out.push(`    recorded  ${fullDate(entry.createdAt)} (${ago(entry.createdAt)})`);
  if (entry.command) {
    const exit = entry.exitCode === null ? "" : `  →  exit ${entry.exitCode}`;
    out.push(`    attempt   ${entry.command}${exit}`);
  }
  if (entry.normalized && entry.normalized !== entry.command) {
    out.push(`    normalised ${entry.normalized}`);
  }
  if (entry.excerpt) out.push(`    symptom   ${entry.excerpt}`);
  if (entry.fingerprint) out.push(`    signature ${shortDigest(entry.fingerprint)}`);
  if (entry.why) out.push(`    why       ${entry.why}`);
  if (entry.retry) out.push(`    instead   ${entry.retry}`);
  if (entry.evidence.length > 0) out.push(`    evidence  ${entry.evidence.join(", ")}`);
  if (entry.tags.length > 0) out.push(`    tags      ${entry.tags.join(", ")}`);
  if (entry.retiredAt) {
    out.push(`    retired   ${fullDate(entry.retiredAt)} — ${entry.retireReason ?? ""}`);
  }

  out.push(`    anchors   ${anchorSummary(view.checks)}`);
  for (const check of view.checks) out.push(anchorLine(check));

  if (entry.notes.length > 0) {
    out.push(`    notes`);
    for (const note of entry.notes) out.push(`      - ${note}`);
  }

  if (entry.history.length > 0) {
    out.push(`    history`);
    for (const h of entry.history.slice(-10)) {
      out.push(`      ${fullDate(h.at)}  ${h.event}${h.note ? ` — ${h.note}` : ""}`);
    }
  }

  return `${out.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */

/**
 * @param {StatusSummary} summary
 * @returns {string}
 */
export function renderStatus(summary) {
  /** @type {string[]} */
  const out = [];
  out.push(`repo       ${summary.root}`);
  out.push(`ledger     ${summary.ledger}`);
  out.push(`entries    ${summary.total}`);
  out.push(`  active   ${summary.active}`);
  out.push(`  suspect  ${summary.suspect}`);
  out.push(`  retired  ${summary.retired}`);

  if (summary.attention.length > 0) {
    out.push("");
    out.push(
      summary.attention.length === 1
        ? "⚠ 1 entry needs attention:"
        : `⚠ ${summary.attention.length} entries need attention:`,
    );
    for (const item of summary.attention) {
      out.push(`    ${item.id}  ${item.title}`);
      out.push(`        ${item.why}`);
    }
  }

  if (summary.total > 0) {
    out.push("");
    out.push(`oldest     ${summary.oldest === null ? "-" : fullDate(summary.oldest)}`);
    out.push(`newest     ${summary.newest === null ? "-" : fullDate(summary.newest)}`);
  }

  if (summary.errors.length > 0) {
    out.push("");
    out.push(`⚠ ${plural(summary.errors.length, "ledger line")} could not be read:`);
    for (const err of summary.errors.slice(0, 5)) out.push(`    ${err}`);
  }

  return `${out.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */

/**
 * @param {RecordResult} result
 * @param {string} ledgerRelative
 * @returns {string}
 */
export function renderRecord(result, ledgerRelative) {
  if (result.ok) {
    /** @type {string[]} */
    const out = [];
    out.push(
      `${result.recurrence ? "Re-recorded" : "Recorded"} ${result.entry.id} — ${result.entry.title}`,
    );
    out.push(`    anchors   ${plural(result.entry.anchors.length, "anchor")}`);
    for (const anchor of result.entry.anchors) out.push(`      ✓ ${anchor.path}`);
    if (result.entry.decay === "none") {
      out.push("");
      out.push("⚠ Recorded with no anchors. It will block forever and cannot expire.");
    }
    out.push("");
    out.push(`Ledger: ${ledgerRelative} — commit it, so the next session and your`);
    out.push("teammates inherit this instead of rediscovering it.");
    return `${out.join("\n")}\n`;
  }

  if (result.reason === "duplicate") {
    return [
      `Already recorded as ${result.existing.id}.`,
      "",
      `  ${result.existing.title}`,
      "",
      "Use `deadend verify` to re-confirm it, or --force to replace this entry",
      "with the new observation (the existing history is kept).",
      "",
    ].join("\n");
  }

  if (result.reason === "no-anchors") {
    /** @type {string[]} */
    const out = [];
    out.push("Refusing to record: no anchors.");
    out.push("");
    out.push("A dead end with nothing to watch can never expire, and a claim that can");
    out.push("never expire is indistinguishable from a bug. Name the files whose content");
    out.push("would have to change for this failure to stop being true.");
    out.push("");
    if (result.suggestions.length > 0) {
      out.push("Suggested anchors (they exist here):");
      for (const s of result.suggestions) out.push(`  --anchor ${s}`);
      out.push("");
    }
    out.push("Or pass --unanchored if this genuinely has no local artifact — it will");
    out.push("block forever, and `deadend status` will keep saying so.");
    return `${out.join("\n")}\n`;
  }

  if (result.reason === "missing-anchors") {
    return [
      "These anchor paths do not exist, so they cannot be watched:",
      ...result.missing.map((m) => `  ${m}`),
      "",
      "An anchor that cannot be hashed would silently never decay. Fix the paths.",
      "",
    ].join("\n");
  }

  if (result.reason === "empty-anchors") {
    return [
      "These anchors cover no files, so their content could never change:",
      ...result.paths.map((p) => `  ${p}`),
      "",
      "A directory anchor watches the files inside it. A directory with nothing",
      "tracked in it — empty, or entirely gitignored — is an anchor that can never",
      "decay: an entry that blocks forever while looking properly anchored.",
      "",
      "Anchor a specific file or a parent directory instead, or pass --unanchored",
      "to say plainly that this claim has no local falsifier.",
      "",
    ].join("\n");
  }

  if (result.reason === "conflicting-anchors") {
    return [
      "Anchors and --unanchored contradict each other.",
      "",
      "An anchor means \"expire when this changes\". --unanchored means \"never",
      "expire\". Accepting both would store anchors that are displayed but never",
      "checked — worse than either, because it looks like diligence.",
      "",
      "Pick one:",
      ...result.anchors.map((a) => `  --anchor ${a}`),
      "  --unanchored",
      "",
    ].join("\n");
  }

  return "A dead end needs a title (`--title`).\n";
}

/**
 * @param {VerifyResult} result
 * @returns {string}
 */
export function renderVerify(result) {
  if (!result.ok) return `No dead end matches "${result.id}".\n`;
  if (result.outcome === "now-works") {
    return [
      `Retired ${result.entry.id} — it works now.`,
      "",
      "It stays in the ledger as history: if this failure comes back, the record",
      "is re-created with the same id and the old observations attached.",
      "",
    ].join("\n");
  }

  /** @type {string[]} */
  const lines = [`Re-confirmed ${result.entry.id} — still fails.`, ""];

  // Re-confirming only means something if there were anchors to re-pin. Saying
  // "it is authoritative again" in either of these cases would be false.
  if (result.entry.decay === "none") {
    lines.push("⚠ This entry has no anchors, so re-confirming it changed nothing:");
    lines.push("  it already blocked, and it will keep blocking whatever the code does.");
    lines.push("  Anchor it if you can, so it is able to expire.");
  } else if (result.anchors.length === 0) {
    lines.push("⚠ None of its anchors could be re-hashed — those paths no longer exist.");
    lines.push("  The entry stays a suspect: there is nothing left to watch, so it cannot");
    lines.push("  become authoritative again. Restore the paths, or retire it.");
  } else {
    lines.push(
      `    anchors re-pinned to the current tree (${plural(result.anchors.length, "anchor")})`,
    );
    for (const a of result.anchors) lines.push(`      ✓ ${a.path}`);
    lines.push("");
    lines.push("It is authoritative again, and will stay so until one of those changes.");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * @param {GcResult} result
 * @returns {string}
 */
export function renderGc(result) {
  const saved = result.bytesBefore - result.bytesAfter;
  /** @type {string[]} */
  const lines = [
    `${result.dryRun ? "Would compact" : "Compacted"} the ledger:`,
    `  entries  ${result.entriesBefore} → ${result.entriesAfter} (dropped ${result.dropped})`,
    `  bytes    ${result.bytesBefore} → ${result.bytesAfter}${
      result.dryRun || saved <= 0 ? "" : ` (saved ${saved})`
    }`,
  ];
  if (result.undecayable > 0) {
    lines.push("");
    lines.push(`⚠ ${plural(result.undecayable, "kept entry", "kept entries")} cannot expire (no anchors).`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {import("./engine.js").MergeResult} result
 * @param {string} ledgerRelative
 * @returns {string}
 */
export function renderMerge(result, ledgerRelative) {
  /** @type {string[]} */
  const lines = [
    "Merged other ledgers into this one:",
    `  added      ${result.added}`,
    `  updated    ${result.updated}`,
    `  unchanged  ${result.unchanged}`,
    `  total      ${result.total}`,
  ];

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`⚠ ${plural(result.errors.length, "incoming line")} could not be read:`);
    for (const err of result.errors.slice(0, 5)) lines.push(`    ${err}`);
  }

  lines.push("");
  lines.push(`The ledger was rewritten compacted at ${ledgerRelative}.`);

  return `${lines.join("\n")}\n`;
}
