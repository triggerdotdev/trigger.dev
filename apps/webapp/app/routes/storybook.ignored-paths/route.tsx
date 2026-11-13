import { IgnoredPatternsEditor } from "~/components/deployments/IgnoredPatternsEditor";
import type { IgnoreKind } from "~/v3/github";
import { StoryPage, StorySection } from "../storybook/StoryKit";

const limits = { maxPatterns: 100, maxLength: 256 };

const states: { title: string; kind: IgnoreKind; patterns: string[] }[] = [
  { title: "No rules", kind: "paths", patterns: [] },
  { title: "A few rules", kind: "paths", patterns: ["docs/**", "**/*.md"] },
  {
    title: "Folded",
    kind: "paths",
    patterns: [
      "docs/**",
      "apps/website/**",
      "apps/marketing/**",
      "**/*.md",
      "**/*.mdx",
      ".github/**",
      ".vscode/**",
      "examples/**",
      "packages/eslint-config/**",
      "scripts/release/**",
      "**/__snapshots__/**",
      "CHANGELOG.md",
      "assets/**",
    ],
  },
  {
    title: "With invalid paths",
    kind: "paths",
    patterns: ["docs/**", "!src/**", "examples/", "**/*.{md,mdx}", "**/a/**/b/**/c"],
  },
  { title: "No branches", kind: "branches", patterns: [] },
  {
    title: "Branches",
    kind: "branches",
    patterns: ["dependabot/**", "noPreview*", "noPreview/**"],
  },
  {
    title: "With invalid branches",
    kind: "branches",
    patterns: ["dependabot/**", "!main", "feature/", "refs/heads/release", "@(fix|feat)/**"],
  },
];

export default function Story_() {
  return (
    <StoryPage
      componentNames={["IgnoredPatternsEditor.tsx"]}
      title="Ignored paths and branches"
      description="The Git settings editor for paths whose changes don't trigger a deployment, and for branches whose pull requests don't get a preview. More than three saved patterns start folded; the flask button checks a path or branch against them as they are typed."
    >
      {states.map(({ title, kind, patterns }) => (
        <StorySection key={title} title={title}>
          <div className="max-w-[37.5rem] rounded-sm border border-grid-dimmed p-4">
            <IgnoredPatternsEditor
              kind={kind}
              name="ignorePatterns"
              defaultPatterns={patterns}
              limits={limits}
            />
          </div>
        </StorySection>
      ))}
    </StoryPage>
  );
}
