import { createContext, useContext, useState } from "react";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useProject } from "~/hooks/useProject";
import { useTriggerCliTag } from "~/hooks/useTriggerCliTag";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "./primitives/ClientTabs";
import { ClipboardField } from "./primitives/ClipboardField";
import { Header3 } from "./primitives/Headers";

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

export function TriggerLoginStepV3({ title }: TabsProps) {
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

export function TriggerDeployStep({ title, environment }: TabsProps & { environment: { type: string } }) {
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
