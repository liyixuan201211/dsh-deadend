/**
 * Turning raw failure output into a stable signature.
 *
 * The problem this solves: the same failure must be recognisable across
 * sessions, machines and reworded commands. Exact command matching misses
 * variations (`npm run build` vs `npm run build --workspace x`); keyword
 * matching on a prompt misses paraphrases. A signature computed from the
 * *evidence* — the error output — is the robust middle, because the one thing
 * that is stable about a failure is the failure.
 *
 * Normalisation must be aggressive enough to survive noise and conservative
 * enough to keep signal. What we deliberately keep: error codes (`ENOENT`,
 * `TS2304`), identifiers, and the wording of the message. What we throw away:
 * anything that differs between two runs of the same failure — line and column
 * numbers, absolute paths, temp directories, hashes, UUIDs, timestamps,
 * durations, byte counts, addresses.
 */
import { collapse, sha256, truncate } from "./util.js";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Lines that look like the actual failure, rather than progress chatter. */
const ERROR_HINT =
  /(error|err!|fail|failed|failure|exception|traceback|panic|fatal|cannot|can't|unable to|not found|no such file|undefined|is not|refused|denied|timed? ?out|unmet|conflict|unresolved|unsupported|missing|invalid|abort|✗|✘|×)/i;

/**
 * @param {string} s
 * @returns {string}
 */
export const stripAnsi = (s) => s.replace(ANSI, "");

/**
 * Replace any token containing a path separator with its final segment, while
 * preserving the punctuation around it (`'a/b/c.ts',` -> `'c.ts',`).
 *
 * @param {string} s
 * @returns {string}
 */
function collapsePaths(s) {
  return s.replace(/\S*[/\\]\S*/g, (token) => {
    const lead = token.match(/^[^\w./\\-]*/)?.[0] ?? "";
    const tail = token.match(/[^\w./\\-]*$/)?.[0] ?? "";
    const core = token.slice(lead.length, token.length - tail.length);
    const last = core.split(/[/\\]/).filter(Boolean).pop() ?? core;
    return lead + last + tail;
  });
}

/**
 * Normalise one line. `lower` controls case folding: the hash uses the folded
 * form (stable across message-case changes) while the stored excerpt keeps the
 * original case so it stays readable.
 *
 * @param {string} line
 * @param {{ lower: boolean }} options
 * @returns {string}
 */
export function normalizeLine(line, options) {
  let s = stripAnsi(line);
  s = collapsePaths(s);

  s = s.replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?z?/gi, " TIME ");
  s = s.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    " UUID ",
  );
  s = s.replace(/\b0x[0-9a-f]+\b/gi, " ADDR ");

  // Line/column refs, which move whenever the file above them changes.
  s = s.replace(/:\d+:\d+/g, ":L:C");
  s = s.replace(/:\d+(?=[)\s"']|$)/g, ":L");
  s = s.replace(/\b(?:line|row|col|column)\s*[:#]?\s*\d+/gi, "line N");

  // Long hex blobs: digests, etags, integrity hashes.
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, " HASH ");

  // Quantities that vary run to run.
  s = s.replace(
    /\b\d+(?:\.\d+)?\s*(?:ms|us|µs|ns|sec|secs|seconds|s|min|mins|kb|mb|gb|tb|bytes?|bps)\b/gi,
    " QTY ",
  );
  s = s.replace(/\b\d{4,}\b/g, " N ");

  s = collapse(s);

  return options.lower ? s.toLowerCase() : s;
}

/**
 * @typedef {object} SymptomSignature
 * @property {string} fingerprint `sha256:<hex>` over the folded signature lines.
 * @property {string} excerpt Short, human-readable form for reports.
 * @property {string[]} keys The normalised lines the hash was computed from.
 */

/**
 * Compute the signature of a chunk of failure output.
 *
 * When the output contains no line that looks like an error we fall back to the
 * tail of the output — most tools print the reason last — so that a signature is
 * still produced rather than nothing.
 *
 * @param {string} raw
 * @param {number} [maxLines]
 * @returns {SymptomSignature}
 */
export function signature(raw, maxLines = 5) {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const hinted = lines.filter((l) => ERROR_HINT.test(l));
  const chosen = hinted.length > 0 ? hinted : lines.slice(-maxLines);

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const keys = [];
  /** @type {string[]} */
  const display = [];

  for (const line of chosen) {
    const key = normalizeLine(line, { lower: true });
    if (!key || key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    display.push(normalizeLine(line, { lower: false }));
    if (keys.length >= maxLines) break;
  }

  const joined = keys.join("\n");
  return {
    fingerprint: `sha256:${sha256(joined)}`,
    excerpt: truncate(display.slice(0, 3).join(" | "), 240),
    keys,
  };
}
