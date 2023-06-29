import {
  ApiAuthenticationMethodApiKey,
  Integration,
} from "~/services/externalApis/types";
import { CodeBlock } from "../code/CodeBlock";
import { InlineCode } from "../code/InlineCode";
import { ClipboardField } from "../primitives/ClipboardField";
import { Header1 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "../primitives/ClientTabs";

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
      <ClientTabs defaultValue="npm">
        <ClientTabsList>
          <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
          <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
          <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
        </ClientTabsList>
        <ClientTabsContent value={"npm"}>
          <ClipboardField
            variant="secondary/medium"
            value={`npm install ${integration.packageName}@next`}
            className="mb-4"
          />
        </ClientTabsContent>
        <ClientTabsContent value={"pnpm"}>
          <ClipboardField
            variant="secondary/medium"
            value={`pnpm install ${integration.packageName}@next`}
            className="mb-4"
          />
        </ClientTabsContent>
        <ClientTabsContent value={"yarn"}>
          <ClipboardField
            variant="secondary/medium"
            value={`yarn add ${integration.packageName}@next`}
            className="mb-4"
          />
        </ClientTabsContent>
      </ClientTabs>
      {apiAuth.help.samples.map((sample, i) => (
        <div key={i}>
          <Paragraph spacing>{sample.title}</Paragraph>
          <CodeBlock
            code={sample.code}
            className="mb-4"
            highlightedRanges={sample.highlight}
          />
        </div>
      ))}
    </div>
  );
}
