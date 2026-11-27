import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { getUserById } from "~/models/user.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { docsJson, docsPreflight, docsReaderUserId } from "~/services/docsReader.server";

// Read by apps/docs/lib/reader.ts (MeResponse there): keep the two in step.
/** What the docs site gets for a signed-in reader. Never a secret key: that's a separate call. */
export type DocsReader = {
  user: { id: string; name: string | null; avatarUrl: string | null };
  organizations: {
    slug: string;
    title: string;
    projects: { ref: string; slug: string; name: string }[];
  }[];
  /** The project the dashboard would open, by the rule it uses after login. */
  lastProjectRef: string | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  // Remix routes OPTIONS to the loader.
  if (request.method.toUpperCase() === "OPTIONS") return docsPreflight(request);
  const auth = await docsReaderUserId(request);
  if (!auth.ok) return auth.response;

  const user = await getUserById(auth.userId);
  if (!user) return docsJson(request, { error: "Unauthenticated" }, 401);

  const organizations = await prisma.organization.findMany({
    where: { deletedAt: null, members: { some: { userId: user.id } } },
    orderBy: { title: "asc" },
    select: {
      slug: true,
      title: true,
      projects: {
        where: { deletedAt: null, version: "V3" },
        orderBy: { name: "asc" },
        select: { id: true, externalRef: true, slug: true, name: true, updatedAt: true },
      },
    },
  });

  const projects = organizations.flatMap((org) => org.projects);
  const lastProject = await new SelectBestEnvironmentPresenter().selectBestProjectFromProjects({
    user,
    projectSlug: undefined,
    projects,
  });

  const reader: DocsReader = {
    user: { id: user.id, name: user.displayName ?? user.name, avatarUrl: user.avatarUrl },
    organizations: organizations.map((org) => ({
      slug: org.slug,
      title: org.title,
      projects: org.projects.map((project) => ({
        ref: project.externalRef,
        slug: project.slug,
        name: project.name,
      })),
    })),
    lastProjectRef: projects.find((p) => p.id === lastProject?.id)?.externalRef ?? null,
  };

  return docsJson(request, reader);
}
