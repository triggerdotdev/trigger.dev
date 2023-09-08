import { InlineCode } from "./code/InlineCode";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "./primitives/ClientTabs";
import { ClipboardField } from "./primitives/ClipboardField";
import { Paragraph } from "./primitives/Paragraph";

export function InitCommand({ appOrigin, apiKey }: { appOrigin: string; apiKey: string }) {
  return (
    <ClientTabs defaultValue="npm">
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          secure={`npx @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
          value={`npx @trigger.dev/cli@latest init -k ${apiKey} -t ${appOrigin}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          secure={`pnpm dlx @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
          value={`pnpm dlx @trigger.dev/cli@latest init -k ${apiKey} -t ${appOrigin}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          secure={`yarn dlx @trigger.dev/cli@latest init -k ••••••••• -t ${appOrigin}`}
          value={`yarn dlx @trigger.dev/cli@latest init -k ${apiKey} -t ${appOrigin}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function RunDevCommand() {
  return (
    <ClientTabs defaultValue="npm">
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField variant="primary/medium" className="mb-4" value={`npm run dev`} />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField variant="primary/medium" className="mb-4" value={`pnpm run dev`} />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField variant="primary/medium" className="mb-4" value={`yarn run dev`} />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function TriggerDevCommand() {
  return (
    <ClientTabs defaultValue="npm">
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`npx @trigger.dev/cli@latest dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`pnpm dlx @trigger.dev/cli@latest dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`yarn dlx @trigger.dev/cli@latest dev`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function TriggerDevStep() {
  return (
    <>
      <Paragraph spacing>
        In a <span className="text-amber-400">separate terminal window or tab</span> run:
      </Paragraph>
      <TriggerDevCommand />
      <Paragraph spacing variant="small">
        If you’re not running on port 3000 you can specify the port by adding{" "}
        <InlineCode variant="extra-small">--port 3001</InlineCode> to the end.
      </Paragraph>
      <Paragraph spacing variant="small">
        You should leave the <InlineCode variant="extra-small">dev</InlineCode> command running when
        you're developing.
      </Paragraph>
    </>
  );
}
