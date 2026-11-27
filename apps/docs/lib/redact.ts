// Readers sometimes paste keys or emails into Ask AI, search or feedback. That text goes to
// analytics and, from there, into the content-gap issues, so it's redacted before it leaves.
const PATTERNS: [RegExp, string][] = [
  [/\btr_[a-z]+_[A-Za-z0-9_]+/g, "[key]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  // Other providers' keys and tokens, JWTs, then any long run of letters and digits.
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/g,
    "[token]",
  ],
  [/\b(?=[A-Za-z_]*\d)(?=[0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g, "[token]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((out, [pattern, label]) => out.replace(pattern, label), text);
}
