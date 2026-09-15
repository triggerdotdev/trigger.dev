import { formatTriggerUri, type ParsedTriggerUri } from "@internal/dashboard-agent-contracts";
import { resolvedScopeFor, scopedParsedUri } from "./tool-evidence";
import type { ReadScope, SourceReadLookup } from "./tool-source-ledger";

/**
 * Turns the ids a card's prose names into inline markdown links, against this turn's read
 * ledger and nothing else: an id the turn never read stays plain text. Only kinds the
 * frozen URI grammar already has, and only the ones a user sees named.
 */
const LINKABLE_KINDS = ["run", "error", "queue", "deployment"] as const;

// Markdown the rewriter must leave alone: fenced blocks, code spans, existing links and
// images, autolinks, and any bare URL that might already contain one of these ids.
const PROTECTED =
  /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** A queue or deployment is named, not prefixed, so a bare short word like "default" would
 * turn ordinary prose into links. Such a name links only when it is distinctive enough on
 * its own, or when the sentence says what it is. */
const NAME_MIN_LENGTH = 4;
const NAMING_WORD = /(?:^|[^A-Za-z])(?:queue|deployment|version)\s*$/i;

type Candidate = { text: string; uri: string; specific: boolean };

// `-`, `/` and `.` can extend an id, so a match is only whole when neither side continues
// into another word — `worker` must not match inside `task/worker-1`.
const WORD = /[A-Za-z0-9_]/;

function boundedAt(text: string, start: number, end: number): boolean {
  const before = (offset: number) => text[offset] ?? "";
  const continues = (edge: string, outer: string) =>
    WORD.test(edge) || ("-/.".includes(edge) && WORD.test(outer));
  if (start > 0 && continues(before(start - 1), before(start - 2))) return false;
  if (end < text.length && continues(before(end), before(end + 1))) return false;
  return true;
}

// encodeURIComponent leaves parens alone, and a bare paren closes a markdown destination.
function markdownDestination(uri: string): string {
  return uri.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// Anything that would be read as markup inside the link label rather than as the name.
// `_` is exempt between two alphanumerics: CommonMark keeps intraword `_` literal, and
// escaping it would put a visible backslash into every `run_…` label.
function markdownLabel(id: string): string {
  return id.replace(/[\\[\]`*_]/g, (char, at: number) => {
    if (
      char === "_" &&
      /[A-Za-z0-9]/.test(id[at - 1] ?? "") &&
      /[A-Za-z0-9]/.test(id[at + 1] ?? "")
    )
      return char;
    return `\\${char}`;
  });
}

/** Undoes `linkifyAgentText` for anywhere the emitted text is reused as plain prose. */
export function stripAgentLinks(text: string): string {
  // The label may hold escaped brackets, so it is read escape-aware before unescaping.
  return text.replace(/!?\[((?:\\.|[^\\\]])*)\]\([^)]*\)/g, "$1").replace(/\\([\\[\]`*_])/g, "$1");
}

function candidatesFor(reads: SourceReadLookup, base: ReadScope): Candidate[] {
  const candidates: Candidate[] = [];
  for (const kind of LINKABLE_KINDS) {
    for (const id of reads.identitiesRead(kind)) {
      const resolved = resolvedScopeFor(kind, id, reads, base);
      // Read from two environments with neither being this one: no default isn't a guess.
      if (!resolved.ok) continue;
      const parsed: ParsedTriggerUri =
        kind === "run"
          ? { ...resolved.scope, kind: "run", runId: id }
          : scopedParsedUri(kind, resolved.scope, id);
      const uri = formatTriggerUri(parsed);
      // A run or error id carries its own prefix, so it is never an ordinary word.
      const specific =
        kind === "run" ||
        kind === "error" ||
        (id.length >= NAME_MIN_LENGTH && /[^A-Za-z]/.test(id));
      candidates.push({ text: id, uri, specific });
      // The ledger keys errors on the bare fingerprint; prose names the prefixed id.
      if (kind === "error") candidates.push({ text: `error_${id}`, uri, specific: true });
    }
  }
  // Longest first, so a name that contains another links as itself.
  return candidates.sort((a, b) => b.text.length - a.text.length);
}

function linkifySegment(segment: string, candidates: Candidate[]): string {
  let out = "";
  let i = 0;
  outer: while (i < segment.length) {
    for (const candidate of candidates) {
      if (!segment.startsWith(candidate.text, i)) continue;
      if (!boundedAt(segment, i, i + candidate.text.length)) continue;
      if (!candidate.specific && !NAMING_WORD.test(segment.slice(0, i))) continue;
      out += `[${markdownLabel(candidate.text)}](${markdownDestination(candidate.uri)})`;
      i += candidate.text.length;
      continue outer;
    }
    out += segment[i];
    i += 1;
  }
  return out;
}

export function linkifyAgentText(
  text: string,
  reads: SourceReadLookup,
  baseScope: ReadScope
): string {
  if (!text) return text;
  const candidates = candidatesFor(reads, baseScope);
  if (candidates.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(PROTECTED)) {
    const start = match.index;
    out += linkifySegment(text.slice(cursor, start), candidates);
    out += match[0];
    cursor = start + match[0].length;
  }
  return out + linkifySegment(text.slice(cursor), candidates);
}
