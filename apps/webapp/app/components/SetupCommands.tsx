import { createContext, useContext, useState } from "react";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useProject } from "~/hooks/useProject";
import { InlineCode } from "./code/InlineCode";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "./primitives/ClientTabs";
import { ClipboardField } from "./primitives/ClipboardField";
import { Paragraph } from "./primitives/Paragraph";

type PackageManagerContextType = {
  activePackageManager: string;
  setActivePackageManager: (value: string) => void;
};

const PackageManagerContext = createContext<PackageManagerContextType | undefined>(undefined);

export function PackageManagerProvider({ children }: { children: React.ReactNode }) {
  const [activePackageManager, setActivePackageManager] = useState("npm");

  return (
    <PackageManagerContext.Provider value={{ activePackageManager, setActivePackageManager }}>
      {children}
    </PackageManagerContext.Provider>
  );
}

function usePackageManager() {
  const context = useContext(PackageManagerContext);
  if (context === undefined) {
    throw new Error("usePackageManager must be used within a PackageManagerProvider");
  }
  return context;
}

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

export function RunDevCommand({ extra }: { extra?: string }) {
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
          value={`npm run dev${extra ? ` ${extra}` : ""}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`pnpm run dev${extra ? ` ${extra}` : ""}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`yarn run dev${extra ? ` ${extra}` : ""}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function TriggerDevCommand({ extra }: { extra?: string }) {
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
          value={`npx @trigger.dev/cli@latest dev${extra ? ` ${extra}` : ""}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`pnpm dlx @trigger.dev/cli@latest dev${extra ? ` ${extra}` : ""}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`yarn dlx @trigger.dev/cli@latest dev${extra ? ` ${extra}` : ""}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function TriggerDevStep({ extra }: { extra?: string }) {
  return (
    <>
      <Paragraph spacing>
        In a <span className="text-amber-400">separate terminal window or tab</span> run:
      </Paragraph>
      <TriggerDevCommand extra={extra} />
      <Paragraph spacing variant="small">
        If you’re not running on the default you can specify the port by adding{" "}
        <InlineCode variant="extra-small">--port 3001</InlineCode> to the end.
      </Paragraph>
      <Paragraph spacing variant="small">
        You should leave the <InlineCode variant="extra-small">dev</InlineCode> command running when
        you're developing.
      </Paragraph>
    </>
  );
}

const v3PackageTag = "latest";

function getApiUrlArg() {
  const appOrigin = useAppOrigin();

  let apiUrl: string | undefined = undefined;

  switch (appOrigin) {
    case "https://cloud.trigger.dev":
      // don't display the arg, use the CLI default
      break;
    case "https://test-cloud.trigger.dev":
      apiUrl = "https://test-api.trigger.dev";
      break;
    case "https://internal.trigger.dev":
      apiUrl = "https://internal-api.trigger.dev";
      break;
    default:
      apiUrl = appOrigin;
      break;
  }

  return apiUrl ? `-a ${apiUrl}` : undefined;
}

export function InitCommandV3() {
  const project = useProject();
  const projectRef = project.ref;
  const apiUrlArg = getApiUrlArg();

  const initCommandParts = [`trigger.dev@${v3PackageTag}`, "init", `-p ${projectRef}`, apiUrlArg];
  const initCommand = initCommandParts.filter(Boolean).join(" ");

  const { activePackageManager, setActivePackageManager } = usePackageManager();

  return (
    <ClientTabs
      defaultValue="npm"
      value={activePackageManager}
      onValueChange={setActivePackageManager}
    >
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`npx ${initCommand}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`pnpm dlx ${initCommand}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`yarn dlx ${initCommand}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function TriggerDevStepV3() {
  const { activePackageManager, setActivePackageManager } = usePackageManager();

  return (
    <ClientTabs
      defaultValue="npm"
      value={activePackageManager}
      onValueChange={setActivePackageManager}
    >
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`npx trigger.dev@${v3PackageTag} dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`pnpm dlx trigger.dev@${v3PackageTag} dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`yarn dlx trigger.dev@${v3PackageTag} dev`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function TriggerLoginStepV3() {
  const { activePackageManager, setActivePackageManager } = usePackageManager();

  return (
    <ClientTabs
      defaultValue="npm"
      value={activePackageManager}
      onValueChange={setActivePackageManager}
    >
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`npx trigger.dev@${v3PackageTag} login`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`pnpm dlx trigger.dev@${v3PackageTag} login`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          iconButton
          className="mb-4"
          value={`yarn dlx trigger.dev@${v3PackageTag} login`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}
