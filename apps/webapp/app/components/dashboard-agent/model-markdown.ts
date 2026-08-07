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

// Strips inside code fences too: a fence-aware pass is bypassable with a half-fence.
export function stripModelImages(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE, (_whole, alt: string) => plainAlt(alt))
    .replace(MARKDOWN_SHORTCUT_IMAGE, (_whole, alt: string) => plainAlt(alt))
    .replace(FETCHING_TAG, "");
}
