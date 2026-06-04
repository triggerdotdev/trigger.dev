import { json } from "@remix-run/node";
import { Outlet, useLoaderData, type ShouldRevalidateFunction } from "@remix-run/react";
import { apiOperationsMap } from "~/lib/ai-assistant/api-operations.server";
import { DevPresenceProvider } from "~/components/DevPresence";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { MainBody } from "~/components/layout/AppLayout";
import { SideMenu } from "~/components/navigation/SideMenu";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useIsImpersonating, useOrganization, useOrganizations } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { v3ProjectPath } from "~/utils/pathBuilder";
import { AIChatProvider, useAIChat } from "~/components/ai-assistant/AIChatProvider";
import { AIChatPanel } from "~/components/ai-assistant/AIChatPanel";
import { useEffect, useState, type ReactNode } from "react";

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export function loader() {
  return json({ apiOperations: apiOperationsMap });
}

function AIChatLayout({ children }: { children: ReactNode }) {
  const { isOpen } = useAIChat();

  // Keep the panel mounted after the first open so the conversation persists
  // across toggles and so the close transition has something to animate. Lazy
  // mounting avoids the input stealing focus on every page load.
  const [hasOpened, setHasOpened] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setHasOpened(true);
    }
  }, [isOpen]);

  return (
    <div
      className="grid overflow-hidden transition-[grid-template-columns] duration-200 ease-in-out"
      style={{
        gridTemplateColumns: isOpen ? "auto minmax(0, 1fr) 380px" : "auto minmax(0, 1fr) 0px",
      }}
    >
      {children}
      {/* Right-anchored + overflow-hidden so the panel slides in from the right
          edge as the column grows, rather than being revealed left-to-right. */}
      <div className="flex h-full justify-end overflow-hidden">
        {hasOpened && <AIChatPanel />}
      </div>
    </div>
  );
}

export default function Project() {
  const organizations = useOrganizations();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const isImpersonating = useIsImpersonating();
  const { apiOperations } = useLoaderData<typeof loader>();

  return (
    <AIChatProvider userId={user.id} apiOperations={apiOperations}>
      <AIChatLayout>
        <DevPresenceProvider enabled={environment.type === "DEVELOPMENT"}>
          <SideMenu
            user={{ ...user, isImpersonating }}
            project={project}
            environment={environment}
            organization={organization}
            organizations={organizations}
          />
          <MainBody>
            <Outlet />
          </MainBody>
        </DevPresenceProvider>
      </AIChatLayout>
    </AIChatProvider>
  );
}

export function ErrorBoundary() {
  const org = useOrganization();
  const project = useProject();
  return <RouteErrorDisplay button={{ title: project.name, to: v3ProjectPath(org, project) }} />;
}