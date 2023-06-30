import { Help, Integration } from "~/services/externalApis/types";
import { InlineCode } from "../code/InlineCode";
import { Header1 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { HelpInstall } from "./HelpInstall";
import { HelpSamples, ReplacementData } from "./HelpSamples";

export type HelpPanelIntegration = Pick<
  Integration,
  "name" | "packageName" | "identifier"
>;

export type HelpPanelProps = {
  integration: HelpPanelIntegration;
  help?: Help;
  integrationClient?: ReplacementData;
};

export function ApiKeyHelp({
  integration,
  help,
  integrationClient,
}: HelpPanelProps) {
  return (
    <div className="mt-4">
      <Header1 className="mb-2">
        How to use {integration.name} with API keys
      </Header1>
      <Paragraph spacing>
        You can use API keys to authenticate with {integration.name}. Your API
        keys won't leave your server, we'll never see them.
      </Paragraph>
      <Paragraph spacing>
        First install the{" "}
        <InlineCode>{integration.packageName}@next</InlineCode> package using
        your preferred package manager. For example:
      </Paragraph>
      <HelpInstall packageName={integration.packageName} />
      {help && (
        <HelpSamples
          help={help}
          integration={integration}
          integrationClient={integrationClient}
        />
      )}
    </div>
  );
}
