import { Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { type Handle } from "~/utils/handle";
import { ProjectParamSchema, projectPath, v3ProjectPath } from "~/utils/pathBuilder";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const project = await prisma.project.findUnique({
    select: { version: true },
    where: { slug: projectParam },
  });

  if (!project) {
    throw new Response("Project not found", { status: 404, statusText: "Project not found" });
  }

  if (project.version === "V3") {
    return redirect(v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }));
  }

  return null;
};

export const handle: Handle = {
  scripts: (match) => [
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
  return <RouteErrorDisplay button={{ title: project.name, to: projectPath(org, project) }} />;
}
