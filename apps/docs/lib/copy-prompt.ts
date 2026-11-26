// "Copy prompt" on quickstarts and guides: a prompt an AI coding assistant can follow to do what
// the page describes, built from the page's agent markdown (the same text as its .md URL).

/** Pages that walk the reader through doing something: the guides section, or pages with <Steps>. */
export const isPromptPage = (section: string | undefined, markdown: string) =>
  section === "Guides & examples" || /<Steps\b/.test(markdown);

const stripFrontmatter = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n+/, "");

/** `<Steps>`/`<Step title="...">` become numbered headings an assistant reads as an ordered plan. */
export function stepsToMarkdown(md: string) {
  let n = 0;
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (/^<Steps\b[^>]*>$/.test(t)) n = 0;
    else if (t === "</Steps>" || t === "</Step>") continue;
    else if (/^<Step\b[^>]*>$/.test(t)) {
      const title = /title=(?:"([^"]*)"|'([^']*)'|\{["'`]([^"'`]*)["'`]\})/.exec(t);
      n += 1;
      out.push(title ? `### Step ${n}: ${title[1] ?? title[2] ?? title[3]}` : `### Step ${n}`);
    } else out.push(line);
  }
  return out.join("\n");
}

/** The prompt: what to do, where the page lives, then the page itself. */
export function buildPrompt(markdown: string, title: string, mdUrl: string) {
  const body = stepsToMarkdown(stripFrontmatter(markdown)).trim();
  return [
    `Help me do this in my project, following the Trigger.dev docs page "${title}".`,
    `Work through it step by step. Adapt file paths, package manager and framework to what my project already uses, and ask me before running commands that change anything outside the project (deploys, accounts, secrets).`,
    `If you can fetch URLs, the current version of the page is at ${mdUrl}`,
    "",
    "<docs-page>",
    body,
    "</docs-page>",
  ].join("\n");
}
