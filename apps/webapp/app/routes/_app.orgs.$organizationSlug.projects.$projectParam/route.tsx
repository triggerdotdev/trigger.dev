import { Outlet } from "@remix-run/react";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
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
  return (
    <>
      <Outlet />
    </>
  );
}

export function ErrorBoundary() {
  const org = useOrganization();
  const project = useProject();
  return <RouteErrorDisplay button={{ title: project.name, to: v3ProjectPath(org, project) }} />;
}
