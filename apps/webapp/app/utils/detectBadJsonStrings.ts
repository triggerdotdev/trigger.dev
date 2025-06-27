export function detectBadJsonStrings(jsonString: string): boolean {
  // Fast path: skip everything if no \u
  let idx = jsonString.indexOf("\\u");
  if (idx === -1) return false;

  // Only check the area around each \u
  while (idx !== -1 && idx < jsonString.length - 5) {
    if (jsonString[idx + 1] === "u" && jsonString[idx + 2] === "d") {
      const third = jsonString[idx + 3];
      // High surrogate
      if (
        /[89ab]/.test(third) &&
        /[0-9a-f]/.test(jsonString[idx + 4]) &&
        /[0-9a-f]/.test(jsonString[idx + 5])
      ) {
        // Check for low surrogate after
        if (
          jsonString.substr(idx + 6, 2) !== "\\u" ||
          jsonString[idx + 8] !== "d" ||
          !/[cd]/.test(jsonString[idx + 9]) ||
          !/[0-9a-f]/.test(jsonString[idx + 10]) ||
          !/[0-9a-f]/.test(jsonString[idx + 11])
        ) {
          return true; // Incomplete high surrogate
        }
      }
      // Low surrogate
      if (
        (third === "c" || third === "d") &&
        /[0-9a-f]/.test(jsonString[idx + 4]) &&
        /[0-9a-f]/.test(jsonString[idx + 5])
      ) {
        // Check for high surrogate before
        if (
          idx < 6 ||
          jsonString.substr(idx - 6, 2) !== "\\u" ||
          jsonString[idx - 4] !== "d" ||
          !/[89ab]/.test(jsonString[idx - 3]) ||
          !/[0-9a-f]/.test(jsonString[idx - 2]) ||
          !/[0-9a-f]/.test(jsonString[idx - 1])
        ) {
          return true; // Incomplete low surrogate
        }
      }
    }
    idx = jsonString.indexOf("\\u", idx + 1);
  }
  return false;
}
