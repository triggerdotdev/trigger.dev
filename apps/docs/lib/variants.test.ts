import { describe, expect, it } from "vitest";
import { npmVariants } from "./remark-npm-tabs";
import { selectVariants } from "./variants";

const md = `Install:

<CodeGroup>
  \`\`\`bash title="npm"
  npm i @trigger.dev/sdk
  \`\`\`

  \`\`\`bash title="pnpm"
  pnpm add @trigger.dev/sdk
  \`\`\`
</CodeGroup>

<CodeGroup>
  \`\`\`ts title="trigger.config.ts"
  a
  \`\`\`

  \`\`\`ts title="other.ts"
  b
  \`\`\`
</CodeGroup>

<Tabs>
  <Tab title="Next.js API route">
    Next body
  </Tab>

  <Tab title="SvelteKit">
    Svelte body
  </Tab>
</Tabs>
`;

describe("selectVariants", () => {
  // Catches: ?pm= returning every variant, or dropping groups that aren't package managers.
  it("keeps only the chosen package manager and leaves other groups alone", () => {
    const out = selectVariants(md, { pm: "pnpm" });
    expect(out).toContain('```bash title="pnpm"\npnpm add @trigger.dev/sdk\n```');
    expect(out).not.toContain("npm i @trigger.dev/sdk");
    expect(out).toContain('title="other.ts"');
    expect(out).toContain("Svelte body");
  });

  // Catches: framework tabs not matched by label, or the Tab wrapper left in the output.
  it("keeps only the chosen framework tab's content", () => {
    const out = selectVariants(md, { framework: "sveltekit" });
    expect(out).toContain("Svelte body");
    expect(out).not.toContain("Next body");
    expect(out).not.toContain("<Tab");
  });

  // Catches: a choice the group doesn't offer removing all of its variants.
  it("keeps every variant when the group lacks the choice", () => {
    expect(selectVariants(md, { framework: "astro" })).toBe(md);
  });
});

describe("npmVariants", () => {
  // Catches: wrong commands in generated pnpm/yarn/bun tabs.
  it("converts installs and npx, keeping comments", () => {
    expect(
      npmVariants("# login\nnpx trigger.dev@latest login\nnpm i -D @trigger.dev/build")
    ).toEqual({
      pnpm: "# login\npnpm dlx trigger.dev@latest login\npnpm add -D @trigger.dev/build",
      yarn: "# login\nyarn dlx trigger.dev@latest login\nyarn add --dev @trigger.dev/build",
      bun: "# login\nbunx trigger.dev@latest login\nbun add --dev @trigger.dev/build",
    });
  });

  // Catches: tabs generated for blocks that aren't only npm commands, or that can't be translated.
  it("skips mixed or untranslatable blocks", () => {
    expect(npmVariants("npm i x\ncd app")).toBeUndefined();
    expect(npmVariants("npm cache clean --force")).toBeUndefined();
  });
});

describe("selectVariants with lone npm blocks", () => {
  // Catches: ?pm= leaving single npm/npx blocks (tabs on the site) as npm in the markdown.
  it("converts lone npm blocks to the chosen manager, not blocks in groups", () => {
    const out = selectVariants("```bash\nnpx trigger.dev@latest dev\n```\n\n" + md, { pm: "yarn" });
    expect(out).toContain("```bash\nyarn dlx trigger.dev@latest dev\n```");
    expect(out).toContain('title="npm"');
  });
});
