/**
 * Turns `[n]` citations in an answer into markdown links to source n, leaving code alone
 * (fenced blocks and inline code, where `[0]` is an index) and unknown numbers as they are.
 */
export function linkCitations(text: string, sources: Map<number, { url: string }>): string {
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(
            /(`[^`\n]*`)|\[(\d+)\](?!\()/g,
            (whole, code: string | undefined, n: string) => {
              if (code) return code;
              const s = sources.get(Number(n));
              return s ? `[${n}](${s.url})` : whole;
            }
          )
    )
    .join("");
}
