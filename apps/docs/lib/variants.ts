import { groupChoices, type Chosen } from "./choices";
import { MANAGERS, npmVariants, SHELL } from "./remark-npm-tabs";

const FENCE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[ \t]*$/gm;

function fenceTitle(fence: string) {
  const meta = fence.slice(0, fence.indexOf("\n")).replace(/^\s*(`{3,}|~{3,})\S*\s*/, "");
  return /title="([^"]*)"/.exec(meta)?.[1] ?? meta.trim();
}

/** Removes the indentation every non-blank line shares. */
function dedent(text: string) {
  const lines = text.split("\n");
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  );
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

/**
 * Page markdown with only the reader's package manager / framework in each tab group that offers
 * it. Groups without the chosen option, and kinds not chosen, keep every variant.
 */
export function selectVariants(md: string, chosen: Chosen) {
  if (!Object.keys(chosen).length) return md;

  const pick = (labels: string[]) => {
    const g = groupChoices(labels);
    const slug = g && chosen[g.kind];
    return slug ? g.slugs.indexOf(slug) : -1;
  };

  md = md.replace(/^([ \t]*)<CodeGroup>\n([\s\S]*?)\n[ \t]*<\/CodeGroup>/gm, (all, _i, inner) => {
    const fences = (inner as string).match(FENCE) ?? [];
    const i = pick(fences.map(fenceTitle));
    return i >= 0 ? dedent(fences[i]!) : all;
  });

  // Lone npm blocks are tabs on the site (remark-npm-tabs); here they become the chosen manager's.
  const pm = MANAGERS.find((m) => m === chosen.pm);
  if (pm)
    md = md
      .split(/(<CodeGroup>[\s\S]*?<\/CodeGroup>)/)
      .map((part) =>
        part.startsWith("<CodeGroup>")
          ? part
          : part.replace(/^```(\w+)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, (all, lang, code) => {
              const v = SHELL.has(lang) ? npmVariants(code)?.[pm] : undefined;
              return v ? `\`\`\`${lang}\n${v}\n\`\`\`` : all;
            })
      )
      .join("");

  return md.replace(/^([ \t]*)<Tabs>\n([\s\S]*?)\n[ \t]*<\/Tabs>/gm, (all, _i, inner) => {
    const tabs = [
      ...(inner as string).matchAll(/<Tab title="([^"]*)"[^>]*>\n?([\s\S]*?)\n?[ \t]*<\/Tab>/g),
    ];
    const i = pick(tabs.map((t) => t[1]!));
    return i >= 0 ? dedent(tabs[i]![2]!).trim() : all;
  });
}
