import { Outlet } from "@remix-run/react";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { MainBody } from "~/components/layout/AppLayout";
import { SideMenu } from "~/components/navigation/SideMenu";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useIsImpersonating, useOrganization, useOrganizations } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { type Handle } from "~/utils/handle";
import { v3ProjectPath } from "~/utils/pathBuilder";

export const handle: Handle = {
  scripts: () => [
    {
      src: "https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js",
      crossOrigin: "anonymous",
    },
  ],
};

export default function Project() {
  const organizations = useOrganizations();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const isImpersonating = useIsImpersonating();

  return (
    <>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
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
      </div>
    </>
  );
}

export function ErrorBoundary() {
  const org = useOrganization();
  const project = useProject();
  return <RouteErrorDisplay button={{ title: project.name, to: v3ProjectPath(org, project) }} />;
}
