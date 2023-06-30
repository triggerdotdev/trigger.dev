import { Integration } from "~/services/externalApis/types";
import { HelpPanelIntegration, HelpPanelProps } from "./ApiKeyHelp";
import { Paragraph } from "../primitives/Paragraph";
import { CodeBlock } from "../code/CodeBlock";

export type ReplacementData = {
  slug: string;
};

export function HelpSamples({
  help,
  integrationClient,
  integration,
}: HelpPanelProps) {
  return (
    <>
      {help &&
        help.samples.map((sample, i) => {
          const code = runReplacers(
            sample.code,
            integrationClient,
            integration
          );
          return (
            <div key={i}>
              <Paragraph spacing>{sample.title}</Paragraph>
              <CodeBlock
                code={code}
                className="mb-4"
                highlightedRanges={sample.highlight}
              />
            </div>
          );
        })}
    </>
  );
}

const replacements = [
  {
    match: /__SLUG__/g,
    replacement: (
      data: ReplacementData | undefined,
      integration: HelpPanelIntegration
    ) => {
      if (data) return data.slug;
      return integration.identifier;
    },
  },
];

function runReplacers(
  code: string,
  replacementData: ReplacementData | undefined,
  integration: HelpPanelIntegration
) {
  replacements.forEach((r) => {
    code = code.replace(r.match, r.replacement(replacementData, integration));
  });

  return code;
}
