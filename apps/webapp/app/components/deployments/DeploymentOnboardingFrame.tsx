import { cn } from "~/utils/cn";
import type { ReactNode } from "react";
import { EnvironmentIcon } from "~/components/environments/EnvironmentLabel";
import { Header1 } from "~/components/primitives/Headers";
import { ClientTabs, ClientTabsList, ClientTabsTrigger } from "~/components/primitives/ClientTabs";

export function DeploymentOnboardingFrame({
  title,
  heading,
  environment,
  help,
  children,
  enhanced = true,
  tabbed = true,
}: {
  title: string;
  heading?: ReactNode;
  environment: React.ComponentProps<typeof EnvironmentIcon>["environment"];
  help?: ReactNode;
  children: ReactNode;
  enhanced?: boolean;
  tabbed?: boolean;
}) {
  return (
    <>
      <div
        className={cn(
          "mb-2 flex items-center justify-between border-b",
          enhanced && "flex-wrap gap-x-8 gap-y-3 pb-2"
        )}
      >
        <div
          className={cn("flex min-w-0 items-center gap-2", enhanced ? "flex-1 basis-64" : "mb-2")}
        >
          <EnvironmentIcon environment={environment} className="-ml-1 size-8 shrink-0" />
          <Header1 className={enhanced ? "text-balance" : "truncate"}>
            {heading ?? `Deploy your tasks to ${title}`}
          </Header1>
        </div>
        {help && (
          <div className={enhanced ? "flex shrink-0 items-center gap-1" : "flex items-center"}>
            {help}
          </div>
        )}
      </div>
      {tabbed ? (
        <ClientTabs defaultValue="github">
          <ClientTabsList variant="segmented" className="mb-6">
            <ClientTabsTrigger value="github" variant="segmented" layoutId="deploy-tabs">
              GitHub
            </ClientTabsTrigger>
            <ClientTabsTrigger value="cli" variant="segmented" layoutId="deploy-tabs">
              Manual
            </ClientTabsTrigger>
            <ClientTabsTrigger value="github-actions" variant="segmented" layoutId="deploy-tabs">
              GitHub Actions
            </ClientTabsTrigger>
          </ClientTabsList>
          {children}
        </ClientTabs>
      ) : (
        <div className="mt-6">{children}</div>
      )}
    </>
  );
}
