import { boundedIn } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { DEFAULT_ENV_VARS_PAGE_SIZE } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import {
  type EnvironmentVariablesEnvironment,
  loadEnvironmentVariablesEnvironments,
} from "~/presenters/v3/environmentVariablesEnvironments.server";
import {
  canSortEnvironmentVariablesView,
  parseEnvironmentVariablesSort,
  viewAfterSave,
} from "./environmentFilter";

/**
 * The list view to open after a create: switched to show the saved environments when none of
 * them is in view (see `viewAfterSave`), on the page that holds `key` under the view's search
 * and sort. Reads the primary, so it sees the key just written.
 */
export async function viewAfterCreate(
  prismaClient: PrismaClient,
  {
    url,
    userId,
    projectId,
    currentEnvironmentSlug,
    savedEnvironmentIds,
    key,
    pageSize = DEFAULT_ENV_VARS_PAGE_SIZE,
  }: {
    url: string;
    userId: string;
    projectId: string;
    currentEnvironmentSlug: string;
    savedEnvironmentIds: string[];
    key: string;
    pageSize?: number;
  }
): Promise<{
  url: URL;
  switched: boolean;
  savedEnvironments: EnvironmentVariablesEnvironment[];
}> {
  const { environments } = await loadEnvironmentVariablesEnvironments(
    prismaClient,
    { userId, projectId },
    { skipProjectAccessCheck: true }
  );
  const savedEnvironments = environments.filter((environment) =>
    savedEnvironmentIds.includes(environment.id)
  );
  const current = environments.find((e) => e.slug === currentEnvironmentSlug);
  // An archived branch isn't in the list; the list defaults to its type, so do the same here.
  const archivedCurrent = current
    ? null
    : await prismaClient.runtimeEnvironment.findFirst({
        select: { type: true },
        where: { projectId, slug: currentEnvironmentSlug },
      });

  const next = new URL(url);
  const { searchParams, view, switched } = viewAfterSave({
    searchParams: next.searchParams,
    environments,
    currentEnvironmentId: current?.id,
    currentEnvironmentType: archivedCurrent?.type,
    savedEnvironmentIds,
  });
  next.search = searchParams.toString();
  next.searchParams.delete("page");

  // The list's search is a case-insensitive `contains`; a key it hides has no page to open.
  const search = next.searchParams.get("search") ?? undefined;
  if (search && !key.toLowerCase().includes(search.toLowerCase())) {
    return { url: next, switched, savedEnvironments };
  }
  const sort = canSortEnvironmentVariablesView(view)
    ? parseEnvironmentVariablesSort(next.searchParams.get("sort"))
    : undefined;
  const inView = { environmentId: { in: boundedIn(view.environmentIds) } };
  const searched = search ? { contains: search, mode: "insensitive" as const } : {};

  let keysBefore: number;
  if (sort === undefined) {
    keysBefore = await prismaClient.environmentVariable.count({
      where: { projectId, values: { some: inView }, key: { ...searched, lt: key } },
    });
  } else {
    // The presenter places a key by its newest value in view (newest first) or its oldest
    // (oldest first), ties broken by variable id ascending or descending. Count the keys it
    // places before this one.
    const target = await prismaClient.environmentVariable.findFirst({
      select: { id: true, values: { select: { updatedAt: true }, where: inView } },
      where: { projectId, key },
    });
    const times = target?.values.map((value) => value.updatedAt.getTime()) ?? [];
    if (!target || times.length === 0) {
      return { url: next, switched, savedEnvironments };
    }
    const newest = sort === "updated";
    const at = new Date(newest ? Math.max(...times) : Math.min(...times));
    keysBefore = await prismaClient.environmentVariable.count({
      where: {
        projectId,
        key: searched,
        OR: [
          { values: { some: { ...inView, updatedAt: newest ? { gt: at } : { lt: at } } } },
          {
            id: newest ? { lt: target.id } : { gt: target.id },
            values: { some: { ...inView, updatedAt: at } },
          },
        ],
      },
    });
  }

  const page = Math.floor(keysBefore / pageSize) + 1;
  if (page > 1) {
    next.searchParams.set("page", String(page));
  }
  return { url: next, switched, savedEnvironments };
}
