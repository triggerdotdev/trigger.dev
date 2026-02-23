import chalk from "chalk";

const VALID_TAGS = new Set([
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
  "bold",
]);

type Token = { type: "text"; value: string } | { type: "styled"; tag: string; value: string };

/**
 * Parse `{tag}text{/tag}` markup and apply chalk colors.
 * On malformed input (unclosed, mismatched, or nested tags), returns the entire
 * string styled with `fallbackStyle` (or unstyled if no fallback).
 */
export function applyColorMarkup(
  text: string,
  fallbackStyle?: (t: string) => string
): string {
  const tokens = tokenize(text);
  if (!tokens) {
    // Malformed markup — apply fallback to entire string
    return fallbackStyle ? fallbackStyle(text) : text;
  }

  if (tokens.length === 0) return "";

  return tokens
    .map((token) => {
      if (token.type === "text") {
        return fallbackStyle ? fallbackStyle(token.value) : token.value;
      }
      const colorFn = (chalk as unknown as Record<string, unknown>)[token.tag];
      if (typeof colorFn === "function") {
        return (colorFn as (t: string) => string)(token.value);
      }
      return fallbackStyle ? fallbackStyle(token.value) : token.value;
    })
    .join("");
}

/**
 * Tokenize a string with `{tag}...{/tag}` markup.
 * Returns null if the markup is malformed (unclosed, mismatched, or nested tags).
 * Braces with unrecognized tag names pass through as literal text.
 */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let pos = 0;
  let currentText = "";
  let insideTag: string | null = null;

  while (pos < text.length) {
    const braceIdx = text.indexOf("{", pos);

    if (braceIdx === -1) {
      currentText += text.slice(pos);
      break;
    }

    const closeIdx = text.indexOf("}", braceIdx);
    if (closeIdx === -1) {
      // No closing brace — treat rest as literal
      currentText += text.slice(pos);
      break;
    }

    const tagContent = text.slice(braceIdx + 1, closeIdx);

    // Check for closing tag
    if (tagContent.startsWith("/")) {
      const closingName = tagContent.slice(1);

      if (VALID_TAGS.has(closingName)) {
        if (insideTag === null) {
          // Close tag without open — malformed
          return null;
        }
        if (insideTag !== closingName) {
          // Mismatched close — malformed
          return null;
        }

        // Add text before this brace to the styled content
        currentText += text.slice(pos, braceIdx);
        tokens.push({ type: "styled", tag: insideTag, value: currentText });
        currentText = "";
        insideTag = null;
        pos = closeIdx + 1;
        continue;
      }
    }

    // Check for opening tag
    if (VALID_TAGS.has(tagContent)) {
      if (insideTag !== null) {
        // Nesting — malformed
        return null;
      }

      currentText += text.slice(pos, braceIdx);
      if (currentText) {
        tokens.push({ type: "text", value: currentText });
        currentText = "";
      }
      insideTag = tagContent;
      pos = closeIdx + 1;
      continue;
    }

    // Not a recognized tag — treat braces as literal text
    currentText += text.slice(pos, closeIdx + 1);
    pos = closeIdx + 1;
  }

  // If we're still inside a tag at the end, that's malformed
  if (insideTag !== null) {
    return null;
  }

  if (currentText) {
    tokens.push({ type: "text", value: currentText });
  }

  return tokens;
}
