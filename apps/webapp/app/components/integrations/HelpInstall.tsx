import { Integration } from "~/services/externalApis/types";
import { InlineCode } from "../code/InlineCode";
import {
  ClientTabs,
  ClientTabsList,
  ClientTabsTrigger,
  ClientTabsContent,
} from "../primitives/ClientTabs";
import { ClipboardField } from "../primitives/ClipboardField";
import { Paragraph } from "../primitives/Paragraph";

export function HelpInstall({ packageName }: { packageName: string }) {
  return (
    <>
      <ClientTabs defaultValue="npm">
        <ClientTabsList>
          <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
          <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
          <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
        </ClientTabsList>
        <ClientTabsContent value={"npm"}>
          <ClipboardField
            variant="secondary/medium"
            value={`npm install ${packageName}`}
            className="mb-4"
          />
        </ClientTabsContent>
        <ClientTabsContent value={"pnpm"}>
          <ClipboardField
            variant="secondary/medium"
            value={`pnpm install ${packageName}`}
            className="mb-4"
          />
        </ClientTabsContent>
        <ClientTabsContent value={"yarn"}>
          <ClipboardField
            variant="secondary/medium"
            value={`yarn add ${packageName}`}
            className="mb-4"
          />
        </ClientTabsContent>
      </ClientTabs>
    </>
  );
}
