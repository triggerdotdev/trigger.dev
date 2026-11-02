import { IgnoredPathsEditor } from "~/components/deployments/IgnoredPathsEditor";
import { StoryPage, StorySection } from "../storybook/StoryKit";

const limits = { maxPaths: 100, maxLength: 256 };

const states = [
  { title: "No rules", patterns: [] },
  { title: "A few rules", patterns: ["docs/**", "**/*.md"] },
  {
    title: "Folded",
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
    patterns: ["docs/**", "!src/**", "examples/", "**/*.{md,mdx}", "**/a/**/b/**/c"],
  },
];

export default function Story_() {
  return (
    <StoryPage
      componentNames={["IgnoredPathsEditor.tsx"]}
      title="Ignored paths"
      description="The Git settings editor for paths whose changes don't trigger a deployment. More than three saved paths start folded; the flask button checks a file path against them as they are typed."
    >
      {states.map(({ title, patterns }) => (
        <StorySection key={title} title={title}>
          <div className="max-w-[37.5rem] rounded-sm border border-grid-dimmed p-4">
            <IgnoredPathsEditor name="ignorePaths" defaultPatterns={patterns} limits={limits} />
          </div>
        </StorySection>
      ))}
    </StoryPage>
  );
}
