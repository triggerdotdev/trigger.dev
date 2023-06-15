import {
  ApiAuthenticationMethodApiKey,
  Integration,
} from "~/services/externalApis/types";
import { Paragraph } from "../primitives/Paragraph";
import { CodeBlock } from "../code/CodeBlock";
import { InlineCode } from "../code/InlineCode";
import { Header1, Header2 } from "../primitives/Headers";

export function ApiKeyHelp({
  integration,
  apiAuth,
}: {
  integration: Integration;
  apiAuth: ApiAuthenticationMethodApiKey;
}) {
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
        First install the <InlineCode>{integration.packageName}</InlineCode>{" "}
        package using your preferred package manager. For example:
      </Paragraph>
      <CodeBlock
        code={`npm install ${integration.packageName}`}
        className="mb-4"
      />
      <Paragraph spacing>
        Then in your code you can use the integration like this:
      </Paragraph>
      <CodeBlock code={apiAuth.help.sample} className="mb-4" />
    </div>
  );
}
