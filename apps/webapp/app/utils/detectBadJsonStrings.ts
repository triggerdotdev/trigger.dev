/**
 * Detects unpaired UTF-16 surrogate escape sequences in JSON-encoded text.
 *
 * Returns true if the input contains a `\uD8XX`/`\uD9XX`/`\uDAXX`/`\uDBXX`
 * high-surrogate escape not immediately followed by a `\uDC..`–`\uDF..` low
 * surrogate, or a `\uDC..`–`\uDF..` low surrogate not immediately preceded by
 * a high surrogate. Strict JSON parsers (e.g. ClickHouse `JSONEachRow`)
 * reject input containing such sequences.
 *
 * Surrogate hex ranges (case-insensitive — inputs from `JSON.stringify` are
 * lowercase):
 *   - High surrogate (U+D800–U+DBFF):  `\uD[8-B][0-9A-F][0-9A-F]`
 *   - Low surrogate  (U+DC00–U+DFFF):  `\uD[C-F][0-9A-F][0-9A-F]`
 */
export function detectBadJsonStrings(jsonString: string): boolean {
  // Fast path: skip everything if no \u
  let idx = jsonString.indexOf("\\u");
  if (idx === -1) return false;

  // Use a more efficient scanning strategy
  const length = jsonString.length;

  while (idx !== -1 && idx < length - 5) {
    // Only check if we have enough characters left
    if (idx + 6 > length) break;

    if (jsonString[idx + 1] === "u" && jsonString[idx + 2] === "d") {
      const third = jsonString[idx + 3];

      // High surrogate check — third nibble is 8, 9, a, or b (U+D800–U+DBFF)
      if (
        /[89ab]/.test(third) &&
        /[0-9a-f]/.test(jsonString[idx + 4]) &&
        /[0-9a-f]/.test(jsonString[idx + 5])
      ) {
        // Check for low surrogate after (need at least 6 more chars)
        if (idx + 12 > length) {
          return true; // Incomplete high surrogate (not enough chars left)
        }

        if (
          jsonString[idx + 6] !== "\\" ||
          jsonString[idx + 7] !== "u" ||
          jsonString[idx + 8] !== "d" ||
          !/[c-f]/.test(jsonString[idx + 9]) ||
          !/[0-9a-f]/.test(jsonString[idx + 10]) ||
          !/[0-9a-f]/.test(jsonString[idx + 11])
        ) {
          return true; // Incomplete high surrogate
        }
      }

      // Low surrogate check — third nibble is c, d, e, or f (U+DC00–U+DFFF)
      if (
        /[c-f]/.test(third) &&
        /[0-9a-f]/.test(jsonString[idx + 4]) &&
        /[0-9a-f]/.test(jsonString[idx + 5])
      ) {
        // Check for high surrogate before (need at least 6 chars before)
        if (idx < 6) {
          return true; // Incomplete low surrogate (not enough chars before)
        }

        if (
          jsonString[idx - 6] !== "\\" ||
          jsonString[idx - 5] !== "u" ||
          jsonString[idx - 4] !== "d" ||
          !/[89ab]/.test(jsonString[idx - 3]) ||
          !/[0-9a-f]/.test(jsonString[idx - 2]) ||
          !/[0-9a-f]/.test(jsonString[idx - 1])
        ) {
          return true; // Incomplete low surrogate
        }
      }
    }

    // More efficient next search - skip ahead by 2 to avoid overlapping matches
    idx = jsonString.indexOf("\\u", idx + 2);
  }

  return false;
}
