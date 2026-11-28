import { describe, expect, it } from "vitest";
import { problems } from "../scripts/check-md-links.mjs";
import { absoluteUrl, agentMarkdown } from "./agent-mdx";
import { inlineSnippets } from "./snippets";

const opts = { docsUrl: "https://trigger.dev/docs", pageUrl: "/ai-chat/quick-start" };
const md = (mdx: string, o: Partial<typeof opts> & { pagePath?: string } = {}) =>
  agentMarkdown(mdx, { ...opts, ...o });

// Fixtures are excerpts of real pages (trigger.dev/docs), as the page markdown carries them.
describe("agentMarkdown", () => {
  it("turns Steps into numbered headings with unindented fences (ai-chat/quick-start)", () => {
    const out = md(`<Steps>
  <Step title="Define a chat agent">
    Use \`chat.agent\` from \`@trigger.dev/sdk/ai\`.

    \`\`\`ts trigger/chat.ts
    import { chat } from "@trigger.dev/sdk/ai";

    export const myChat = chat.agent({
      id: "my-chat",
    });
    \`\`\`

    <Note>
      The \`streamText\` passed to \`run\` connects compaction.
    </Note>
  </Step>

  <Step title="Run the CLI \`init\` command">
    Second step.
  </Step>
</Steps>`);
    expect(out).toBe(`### 1. Define a chat agent

Use \`chat.agent\` from \`@trigger.dev/sdk/ai\`.

\`\`\`ts trigger/chat.ts
import { chat } from "@trigger.dev/sdk/ai";

export const myChat = chat.agent({
  id: "my-chat",
});
\`\`\`

> [!NOTE]
> The \`streamText\` passed to \`run\` connects compaction.

### 2. Run the CLI \`init\` command

Second step.
`);
  });

  it("maps every callout kind to a GFM alert, including one-line callouts", () => {
    const out = md(`<Warning>Careful.</Warning>

<Tip>
  A tip.
</Tip>

<Info>Some info.</Info>`);
    expect(out).toBe(`> [!WARNING]
> Careful.

> [!TIP]
> A tip.

> [!NOTE]
> Some info.
`);
  });

  it("writes the private beta and rolling out warnings without the flag (troubleshooting-alerts)", () => {
    const out = md(`## Limits alerts

<PrivateBeta flag="alertsEnabled" />

<RollingOut flag="allowEmptyEnvironmentVariableValues" />`);
    expect(out).toContain(
      "> [!WARNING]\n> **Private beta.** This feature is only available to some organizations right now."
    );
    expect(out).toContain(
      "> [!WARNING]\n> **Rolling out.** This feature is being enabled gradually"
    );
    expect(out).not.toContain("alertsEnabled");
    expect(out).not.toContain("allowEmpty");
  });

  it("turns params into a nested bullet list (context)", () => {
    const out = md(`<ResponseField name="task" type="object">
  <Expandable title="properties" defaultOpen={true}>
    <ResponseField name="exportName" type="string">
      The exported function name of the task e.g. \`myTask\`.
    </ResponseField>
    <ResponseField name="id" type="string">
      The ID of the task.
    </ResponseField>
  </Expandable>
</ResponseField>

<ParamField path="runId" type="string" required>
  The ID of the run.
</ParamField>
<ParamField query="limit" type="number" default={25}>
  Page size.
</ParamField>`);
    expect(out).toBe(`- \`task\` (object)
  - \`exportName\` (string): The exported function name of the task e.g. \`myTask\`.
  - \`id\` (string): The ID of the task.
- \`runId\` (string, path, required): The ID of the run.
- \`limit\` (number, query, default: 25): Page size.
`);
  });

  it("turns cards into an absolute link list", () => {
    const out = md(`<CardGroup cols={2}>
  <Card title="How to trigger your tasks" icon="bolt" href="/triggering">
    Trigger tasks from your backend.
  </Card>
  <Card title="Streams" icon="wave-pulse" href="/tasks/streams#reading" />
</CardGroup>`);
    expect(out)
      .toBe(`- [How to trigger your tasks](https://trigger.dev/docs/triggering.md): Trigger tasks from your backend.
- [Streams](https://trigger.dev/docs/tasks/streams.md#reading)
`);
  });

  it("labels the fences of tabs and code groups (mcp-remote)", () => {
    const out = md(`<Tabs>
  <Tab title="Claude Code">
    \`\`\`bash
    claude mcp add --transport http trigger https://mcp.trigger.dev/mcp
    \`\`\`
  </Tab>
</Tabs>

<CodeGroup>
\`\`\`bash npm
npm i @trigger.dev/sdk
\`\`\`
\`\`\`bash pnpm
pnpm add @trigger.dev/sdk
\`\`\`
</CodeGroup>`);
    expect(out).toBe(`**Claude Code**

\`\`\`bash
claude mcp add --transport http trigger https://mcp.trigger.dev/mcp
\`\`\`

**npm**

\`\`\`bash npm
npm i @trigger.dev/sdk
\`\`\`

**pnpm**

\`\`\`bash pnpm
pnpm add @trigger.dev/sdk
\`\`\`
`);
  });

  it("gives each changelog entry a version heading above its own (ai-chat/changelog)", () => {
    const out = md(`<Update label="July 2, 2026" description="4.5.0" tags={["SDK", "Bug fix"]}>

## Point chat sessions at a different project

Text.

</Update>`);
    expect(out).toBe(`## 4.5.0 (July 2, 2026)

Tags: SDK, Bug fix

### Point chat sessions at a different project

Text.
`);
  });

  it("drops MDX comments and keeps string expressions (ai-chat/backend)", () => {
    const out = md(`{/* TODO: Anchor stubs for inbound deep links. */}

Run it{" "}now.`);
    expect(out).toBe("Run it now.\n");
  });

  it("un-indents a snippet inlined at an indented tag (guides/frameworks/nextjs)", () => {
    const out = md(`\`\`\`json
{ "path": "blog" }
\`\`\`

    ### Next.js build failing due to missing API key in GitHub CI

    This issue occurs during the Next.js app build.

    \`\`\`ts
    export const dynamic = "force-dynamic";
    \`\`\`
    ### Correctly passing event handlers to React components`);
    expect(out).toContain(
      "### Next.js build failing due to missing API key in GitHub CI\n\nThis issue occurs"
    );
    expect(out).toContain('```ts\nexport const dynamic = "force-dynamic";\n```');
    expect(out).toContain("\n### Correctly passing event handlers");
  });

  it("adds the deploy commands after a guide's first example card (guides/examples)", () => {
    const card = `<Card title="View the example repo on GitHub" icon="github" href="https://github.com/triggerdotdev/gcp-tailscale-example">
  The full source.
</Card>`;
    const out = md(card, { pagePath: "guides/examples/private-gcp-resource.mdx" });
    expect(out).toContain("**Deploy this example to your project**");
    expect(out).toContain("npx degit triggerdotdev/gcp-tailscale-example gcp-tailscale-example");
    expect(md(card, { pagePath: "tasks/overview.mdx" })).not.toContain("Deploy this example");
  });

  it("makes every link and image absolute", () => {
    const out =
      md(`See [Manual setup](/manual-setup), [retries](#retrying) and [a file](/v3-openapi.yaml).

![Dashboard](/images/run.png)

<img src="/images/billing.png" alt="Billing" />

[ref]: /tasks/overview`);
    expect(out).toContain("[Manual setup](https://trigger.dev/docs/manual-setup.md)");
    expect(out).toContain("[retries](https://trigger.dev/docs/ai-chat/quick-start.md#retrying)");
    expect(out).toContain("[a file](https://trigger.dev/docs/v3-openapi.yaml)");
    expect(out).toContain("![Dashboard](https://trigger.dev/docs/images/run.png)");
    expect(out).toContain("![Billing](https://trigger.dev/docs/images/billing.png)");
    expect(out).toContain("[ref]: https://trigger.dev/docs/tasks/overview.md");
    expect(problems(out)).toEqual([]);
  });
});

describe("absoluteUrl", () => {
  it.each([
    ["/triggering", "https://trigger.dev/docs/triggering.md"],
    ["/docs/triggering#x", "https://trigger.dev/docs/triggering.md#x"],
    ["/tasks/overview/", "https://trigger.dev/docs/tasks/overview.md"],
    ["/", "https://trigger.dev/docs/introduction.md"],
    ["/skill.md", "https://trigger.dev/docs/skill.md"],
    ["backend", "https://trigger.dev/docs/ai-chat/backend.md"],
    ["https://github.com/triggerdotdev", "https://github.com/triggerdotdev"],
    ["mailto:help@trigger.dev", "mailto:help@trigger.dev"],
  ])("%s", (url, want) => expect(absoluteUrl(url, opts)).toBe(want));

  it("sends links to url-frontmatter stubs to their destination", () => {
    const external = new Map([["/community", "https://trigger.dev/discord"]]);
    expect(absoluteUrl("/community", { ...opts, external })).toBe("https://trigger.dev/discord");
    // Outside /docs (../../blog/community from /docs/ai-chat/x) is not the stub.
    expect(absoluteUrl("../../blog/community", { ...opts, external })).toBe(
      "https://trigger.dev/blog/community"
    );
  });
});

describe("problems (check-md-links)", () => {
  it("flags relative links and leftover components outside code only", () => {
    expect(
      problems("[a](/x)\n<Note>\n```ts\n[b](/y) <Card />\n```\n`[c](/z)` [d](https://x.dev)")
    ).toEqual(["line 1: link /x", "line 2: component <Note>"]);
  });
});

describe("inlineSnippets", () => {
  it("fills props passed as string expressions (guides/examples/ffmpeg-video-processing)", () => {
    const out = inlineSnippets(
      `<LocalDevelopment packages={"ffmpeg"} />`,
      `import LocalDevelopment from "/snippets/local-development-extensions.mdx";`,
      { "/snippets/local-development-extensions.mdx": "You need to install {packages}." }
    );
    expect(out).toBe("You need to install ffmpeg.");
  });
});
