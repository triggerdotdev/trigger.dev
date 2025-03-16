import { Outlet } from "@remix-run/react";
import { json, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ErrorDisplay, RouteErrorDisplay } from "~/components/ErrorDisplay";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { ProjectParamSchema, v3ProjectPath } from "~/utils/pathBuilder";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const project = await prisma.project.findUnique({
    select: { version: true },
    where: { slug: projectParam },
  });

  if (!project) {
    throw new Response("Project not found", { status: 404, statusText: "Project not found" });
  }

  return typedjson({
    version: project.version,
  });
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
  const { version } = useTypedLoaderData<typeof loader>();

  if (version === "V2") {
    return (
      <ErrorDisplay
        title="Version 2 projects are no longer available"
        message={
          <>
            This project is v2, which was deprecated on Jan 31 2025 after{" "}
            <TextLink to="https://trigger.dev/blog/v2-end-of-life-announcement">
              our announcement in August 2024
            </TextLink>
            .
          </>
        }
      />
    );
  }

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
