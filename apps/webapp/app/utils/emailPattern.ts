/**
 * Match an email against an operator-supplied pattern (ADMIN_EMAILS /
 * WHITELISTED_EMAILS), anchored to the whole address with `^(?:...)$` so the
 * pattern matches the entire email rather than a substring.
 *
 * The non-capturing group keeps top-level alternation working
 * (`a@x.com|b@x.com` stays two whole-string alternatives). Patterns that
 * already carry their own `^`/`$` anchors remain equivalent. A top-level
 * alternative that is just `@domain.tld` is expanded to "any mailbox at exactly
 * that domain".
 *
 * Dependency-free so it can be tested directly; callers pass the pattern from `env`.
 */
export function emailMatchesPattern(pattern: string, email: string): boolean {
  return new RegExp(`^(?:${expandDomainShorthand(pattern)})$`).test(email);
}

function expandDomainShorthand(pattern: string): string {
  return splitTopLevelAlternatives(pattern)
    .map((alternative) => {
      const domain = alternative.match(/^@([A-Za-z0-9.-]+)$/)?.[1];
      return domain ? `[^@]+@${escapeRegExp(domain)}` : alternative;
    })
    .join("|");
}

function splitTopLevelAlternatives(pattern: string): string[] {
  const alternatives: string[] = [];
  let current = "";
  let escaped = false;
  let depth = 0;
  let inCharacterClass = false;

  for (const char of pattern) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (char === "[" && !inCharacterClass) {
      inCharacterClass = true;
    } else if (char === "]" && inCharacterClass) {
      inCharacterClass = false;
    } else if (!inCharacterClass && char === "(") {
      depth++;
    } else if (!inCharacterClass && char === ")" && depth > 0) {
      depth--;
    }

    if (char === "|" && depth === 0 && !inCharacterClass) {
      alternatives.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  alternatives.push(current);
  return alternatives;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
