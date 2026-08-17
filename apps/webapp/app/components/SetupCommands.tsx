import { CheckIcon, SparklesIcon } from "@heroicons/react/20/solid";
import { createContext, useContext, useRef, useState } from "react";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useProject } from "~/hooks/useProject";
import { useTriggerCliTag } from "~/hooks/useTriggerCliTag";
import { Button } from "./primitives/Buttons";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "./primitives/ClientTabs";
import { ClipboardField } from "./primitives/ClipboardField";
import { Header3 } from "./primitives/Headers";
import { SimpleTooltip } from "./primitives/Tooltip";

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

function useApiUrl() {
  const appOrigin = useAppOrigin();

  switch (appOrigin) {
    case "https://cloud.trigger.dev":
      return undefined;
    case "https://test-cloud.trigger.dev":
      return "https://test-api.trigger.dev";
    case "https://internal.trigger.dev":
      return "https://internal-api.trigger.dev";
    default:
      return appOrigin;
  }
}

function getApiUrlArg() {
  const apiUrl = useApiUrl();
  return apiUrl ? `-a ${apiUrl}` : undefined;
}

// Add title prop to the component interfaces
type TabsProps = {
  title?: string;
};

export function InitCommandV3({ title }: TabsProps) {
  const project = useProject();
  const projectRef = project.externalRef;
  const apiUrlArg = getApiUrlArg();
  const triggerCliTag = useTriggerCliTag();

  const initCommandParts = [`trigger.dev@${triggerCliTag}`, "init", `-p ${projectRef}`, apiUrlArg];
  const initCommand = initCommandParts.filter(Boolean).join(" ");

  const { activePackageManager, setActivePackageManager } = usePackageManager();

  return (
    <ClientTabs
      defaultValue="npm"
      value={activePackageManager}
      onValueChange={setActivePackageManager}
    >
      <div className="flex items-center gap-4">
        {title && <span>{title}</span>}
        <ClientTabsList className={title ? "ml-auto" : ""}>
          <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
          <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
          <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
        </ClientTabsList>
      </div>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`npx ${initCommand}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`pnpm dlx ${initCommand}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`yarn dlx ${initCommand}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

function buildAgentSetupPrompt({
  projectRef,
  apiUrl,
  cliTag,
}: {
  projectRef: string;
  apiUrl: string | undefined;
  cliTag: string;
}) {
  const apiUrlArg = apiUrl ? ` -a ${apiUrl}` : "";
  const apiUrlLine = apiUrl ? `\nTrigger.dev API URL: ${apiUrl}` : "";

  return `Set up Trigger.dev in this project.

Trigger.dev runs your background tasks. This is an existing codebase — add Trigger.dev to it and get one task running in the development environment.

Project reference: ${projectRef}${apiUrlLine}

How to do it:
1. If you have the Trigger.dev MCP server available, use its "initialize_project" tool with the project reference above.
2. Otherwise run this and follow its output:
   npx trigger.dev@${cliTag} init -p ${projectRef}${apiUrlArg}
3. If you set it up by hand, follow https://trigger.dev/docs/manual-setup and make sure you end up with:
   - "@trigger.dev/sdk" installed (latest) and "@trigger.dev/build" as a dev dependency
   - a trigger.config.ts with: import { defineConfig } from "@trigger.dev/sdk", project: "${projectRef}", dirs: ["./src/trigger"], and a maxDuration
   - a src/trigger/ directory with at least one exported task created with task() from "@trigger.dev/sdk"
   - trigger.config.ts added to tsconfig "include", and ".trigger" added to .gitignore

Golden rules:
- Import from "@trigger.dev/sdk". Never "@trigger.dev/sdk/v3" or the deprecated client.defineJob.
- Export every task, including subtasks.
- Use the built-in fetch, not node-fetch.
- Never wrap wait.*, triggerAndWait, or batchTriggerAndWait in Promise.all.

Two steps I have to do myself — ask me when you need them:
- Running "npx trigger.dev@${cliTag} login" (it opens a browser).
- Giving you the development TRIGGER_SECRET_KEY from the dashboard to put in .env.

When you're done, run "npx trigger.dev@${cliTag} dev" and confirm the task shows up in the Trigger.dev dashboard.`;
}

export function InitAgentPromptV3() {
  const project = useProject();
  const apiUrl = useApiUrl();
  const cliTag = useTriggerCliTag();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCopy = () => {
    const prompt = buildAgentSetupPrompt({
      projectRef: project.externalRef,
      apiUrl,
      cliTag,
    });
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    void navigator.clipboard.writeText(prompt).catch(() => {});
  };

  return (
    <SimpleTooltip
      asChild
      tabbable
      button={
        <Button
          type="button"
          variant="primary/medium"
          LeadingIcon={copied ? CheckIcon : SparklesIcon}
          leadingIconClassName={copied ? "text-success" : undefined}
          onClick={onCopy}
        >
          {copied ? "Copied prompt" : "Copy AI agent prompt"}
        </Button>
      }
      content="Copies a setup prompt to paste into Claude Code, Cursor, or any coding agent"
    />
  );
}

export function TriggerDevStepV3({ title }: TabsProps) {
  const triggerCliTag = useTriggerCliTag();
  const { activePackageManager, setActivePackageManager } = usePackageManager();

  return (
    <ClientTabs
      defaultValue="npm"
      value={activePackageManager}
      onValueChange={setActivePackageManager}
    >
      <div className="flex items-center gap-4">
        {title && <Header3>{title}</Header3>}
        <ClientTabsList className={title ? "ml-auto" : ""}>
          <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
          <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
          <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
        </ClientTabsList>
      </div>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`npx trigger.dev@${triggerCliTag} dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`pnpm dlx trigger.dev@${triggerCliTag} dev`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`yarn dlx trigger.dev@${triggerCliTag} dev`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

function TriggerLoginStepV3({ title }: TabsProps) {
  const triggerCliTag = useTriggerCliTag();
  const { activePackageManager, setActivePackageManager } = usePackageManager();

  return (
    <ClientTabs
      defaultValue="npm"
      value={activePackageManager}
      onValueChange={setActivePackageManager}
    >
      <div className="flex items-center gap-4">
        {title && <span>{title}</span>}
        <ClientTabsList className={title ? "ml-auto" : ""}>
          <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
          <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
          <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
        </ClientTabsList>
      </div>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`npx trigger.dev@${triggerCliTag} login`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`pnpm dlx trigger.dev@${triggerCliTag} login`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`yarn dlx trigger.dev@${triggerCliTag} login`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}

export function TriggerDeployStep({
  title,
  environment,
}: TabsProps & { environment: { type: string } }) {
  const triggerCliTag = useTriggerCliTag();
  const { activePackageManager, setActivePackageManager } = usePackageManager();

  // Generate the environment flag based on environment type
  const getEnvironmentFlag = () => {
    switch (environment.type) {
      case "STAGING":
        return " --env staging";
      case "PREVIEW":
        return " --env preview";
      case "PRODUCTION":
      default:
        return "";
    }
  };

  const environmentFlag = getEnvironmentFlag();

  return (
    <ClientTabs
      defaultValue="npm"
      value={activePackageManager}
      onValueChange={setActivePackageManager}
    >
      <div className="flex items-center gap-4">
        {title && <Header3>{title}</Header3>}
        <ClientTabsList className={title ? "ml-auto" : ""}>
          <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
          <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
          <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
        </ClientTabsList>
      </div>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`npx trigger.dev@${triggerCliTag} deploy${environmentFlag}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`pnpm dlx trigger.dev@${triggerCliTag} deploy${environmentFlag}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="secondary/medium"
          iconButton
          className="mb-4"
          value={`yarn dlx trigger.dev@${triggerCliTag} deploy${environmentFlag}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}
