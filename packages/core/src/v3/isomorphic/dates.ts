/**
 * Attempts to parse a string into a valid Date.
 *
 * Supported formats:
 * - ISO and RFC date strings (e.g. "2025-08-18", "2025-08-18T12:34:56Z")
 * - Natural language dates supported by JS Date (e.g. "August 18, 2025")
 * - Epoch seconds (10-digit numeric string, e.g. "1629302400")
 * - Epoch milliseconds (13-digit numeric string, e.g. "1629302400000")
 *
 * @param input The string to parse.
 * @returns A valid Date object, or undefined if parsing fails.
 */
export function parseDate(input: string): Date | undefined {
  if (typeof input !== "string") return undefined;

  // Handle pure numeric strings as epoch values
  if (/^\d+$/.test(input)) {
    const num = Number(input);

    if (input.length === 10) {
      // Epoch seconds
      return new Date(num * 1000);
    } else if (input.length === 13) {
      // Epoch milliseconds
      return new Date(num);
    } else {
      // Unsupported numeric length
      return undefined;
    }
  }

  // Handle general date strings
  const date = new Date(input);
  return isNaN(date.getTime()) ? undefined : date;
}
