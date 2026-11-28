#!/usr/bin/env node
// Agent markdown at <base> works outside the site: every link and image in llms-full.txt (every
// page's markdown) is absolute, no component tag is left outside code, and a page's .md carries
// X-Robots-Tag: noindex.
// Usage: node scripts/check-md-links.mjs <base, e.g. http://localhost:43000/docs>
/** Markdown outside fenced code and inline code, split into lines. */
export function proseLines(md) {
  let fence;
  return md.split("\n").map((line) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
      return "";
    }
    if (f) {
      fence = f[1];
      return "";
    }
    return line.replace(/(`+)[\s\S]*?\1/g, "");
  });
}

const ABSOLUTE = /^[a-z][a-z\d+.-]*:/i;

/** Link and image targets that are not absolute URLs, and component tags, with their line. */
export function problems(md) {
  const found = [];
  proseLines(md).forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]*)/g))
      if (!ABSOLUTE.test(m[1])) found.push(`line ${i + 1}: link ${m[1] || "(empty)"}`);
    const def = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(\s|$)/.exec(line);
    if (def && !ABSOLUTE.test(def[1])) found.push(`line ${i + 1}: definition ${def[1]}`);
    const tag = /<\/?[A-Z][A-Za-z]*[\s/>]/.exec(line);
    if (tag) found.push(`line ${i + 1}: component ${tag[0].trim()}`);
  });
  return found;
}

if (import.meta.main) {
  const [base] = process.argv.slice(2);
  if (!base) {
    console.error("usage: node scripts/check-md-links.mjs <base>");
    process.exit(2);
  }
  const root = base.replace(/\/$/, "");
  const failures = [];
  const full = await fetch(`${root}/llms-full.txt`);
  if (!full.ok) failures.push(`/llms-full.txt: status ${full.status}`);
  else failures.push(...problems(await full.text()).map((p) => `/llms-full.txt ${p}`));

  const md = await fetch(`${root}/introduction.md`);
  if (md.headers.get("x-robots-tag") !== "noindex")
    failures.push(`/introduction.md: X-Robots-Tag ${md.headers.get("x-robots-tag")}`);

  for (const f of failures.slice(0, 50)) console.log(`FAIL ${f}`);
  if (failures.length > 50) console.log(`... and ${failures.length - 50} more`);
  console.log(failures.length ? `md links: ${failures.length} failed` : "md links: passed");
  process.exitCode = failures.length ? 1 : 0;
}
