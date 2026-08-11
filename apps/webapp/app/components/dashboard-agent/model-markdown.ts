// No model-supplied image is rendered at all: the browser fetches the URL on render, so any
// URL the model controls exfiltrates the page. Alt text is re-emitted as plain prose.

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\s*(?:\([^)]*\)|\[[^\]]*\])/g;

const MARKDOWN_SHORTCUT_IMAGE = /!\[([^\]]*)\]/g;

// Closing bracket optional: an unterminated tag still parses as an element in the browser.
const FETCHING_TAG =
  /<\s*\/?\s*(?:img|image|picture|source|srcset|svg|use|embed|object|iframe|frame|video|audio|track|link|input|script|style|base)\b[^>]*>?/gi;

function plainAlt(alt: string): string {
  return alt.replace(/[![\]<>`]/g, "").trim();
}

/**
 * One pass isn't enough: removing a match can splice the surrounding text into a fresh one
 * (`<scr<script>ipt>`), so repeat until nothing changes. Nesting deep enough to need more than
 * `MAX_PASSES` is adversarial, not real model output, and looping it out is quadratic on the
 * render thread — so past the bound we stop and blunt every character the strips key on. The
 * result is over-stripped, never half-stripped.
 */
const MAX_PASSES = 25;
const STRIP_CHARS = /[![\]<>]/g;

function replaceUntilStable(
  text: string,
  pattern: RegExp,
  replacer: (whole: string, ...groups: string[]) => string
): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = current.replace(pattern, replacer);
    if (next === current) return current;
    current = next;
  }
  return current.replace(STRIP_CHARS, "");
}

// Strips inside code fences too: a fence-aware pass is bypassable with a half-fence.
export function stripModelImages(text: string): string {
  let out = replaceUntilStable(text, MARKDOWN_IMAGE, (_whole, alt: string) => plainAlt(alt));
  out = replaceUntilStable(out, MARKDOWN_SHORTCUT_IMAGE, (_whole, alt: string) => plainAlt(alt));
  return replaceUntilStable(out, FETCHING_TAG, () => "");
}
