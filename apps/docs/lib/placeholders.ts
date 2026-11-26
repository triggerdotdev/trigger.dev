// Placeholders the docs' code samples already use for the reader's own values. A signed-in reader
// sees their project ref and dev secret key in their place (components/personalized-sample.tsx).

// `project: "<project ref>"` in trigger.config.ts samples, and refs written as examples.
const PROJECT_REF =
  /<project[ -]ref>|<your-project-ref>|<project id>|proj_your_project_(?:ref|id_here)|proj_x{6,}|proj_1234\b|proj_abc123\b/g;

// `TRIGGER_SECRET_KEY=tr_dev_sk_...` and the like. Prod, staging and preview keys stay as written.
const DEV_KEY = /tr_dev_(?:sk_)?(?:x{6,}|\.\.\.|…)/g;

type Placeholders = { projectRef: boolean; devKey: boolean };

export function findPlaceholders(text: string): Placeholders {
  return { projectRef: new RegExp(PROJECT_REF).test(text), devKey: new RegExp(DEV_KEY).test(text) };
}

type ReaderValues = { projectRef?: string; devKey?: string };

export function fillPlaceholders(text: string, values: ReaderValues): string {
  return fillParts([text], values)[0]!;
}

/**
 * fillPlaceholders over text split into parts (the tokens of one highlighted line), where a
 * placeholder can span parts: shell highlighting splits `<project-ref>` into `<`, `project-ref`
 * and `>`. A value goes in the part where its placeholder starts; the rest of it is dropped.
 */
export function fillParts(parts: string[], values: ReaderValues): string[] {
  const text = parts.join("");
  const spans: Array<{ start: number; end: number; value: string }> = [];
  const collect = (pattern: RegExp, value?: string) => {
    if (!value) return;
    for (const m of text.matchAll(new RegExp(pattern)))
      spans.push({ start: m.index, end: m.index + m[0].length, value });
  };
  collect(PROJECT_REF, values.projectRef);
  collect(DEV_KEY, values.devKey);
  spans.sort((a, b) => a.start - b.start);

  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.length;
    const end = offset;
    let out = "";
    let pos = start;
    for (const s of spans) {
      if (s.end <= start || s.start >= end) continue;
      if (s.start >= start) out += text.slice(pos, s.start) + s.value;
      pos = Math.min(s.end, end);
    }
    return out + text.slice(pos, end);
  });
}
