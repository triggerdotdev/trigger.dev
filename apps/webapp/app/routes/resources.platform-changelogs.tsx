import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, type ShouldRevalidateFunction } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { requireUserId } from "~/services/session.server";
import { getRecentChangelogs, verifyOrgMembership } from "~/services/platformNotifications.server";

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export type PlatformChangelogsLoaderData = {
  changelogs: Array<{ id: string; title: string; actionUrl?: string }>;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  const rawOrganizationId = url.searchParams.get("organizationId") ?? undefined;
  const rawProjectId = url.searchParams.get("projectId") ?? undefined;

  const { organizationId, projectId } = await verifyOrgMembership({
    userId,
    organizationId: rawOrganizationId,
    projectId: rawProjectId,
  });

  const changelogs = await getRecentChangelogs({ userId, organizationId, projectId });

  return json<PlatformChangelogsLoaderData>({ changelogs });
}

const POLL_INTERVAL_MS = 60_000;

export function useRecentChangelogs(organizationId?: string, projectId?: string) {
  const fetcher = useFetcher<typeof loader>();
  const lastLoadedUrl = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (organizationId) params.set("organizationId", organizationId);
    if (projectId) params.set("projectId", projectId);
    const qs = params.toString();
    const url = `/resources/platform-changelogs${qs ? `?${qs}` : ""}`;

    if (lastLoadedUrl.current !== url && fetcher.state === "idle") {
      lastLoadedUrl.current = url;
      fetcher.load(url);
    }

    const interval = setInterval(() => {
      if (fetcher.state === "idle") {
        fetcher.load(url);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [organizationId, projectId]);

  return {
    changelogs: fetcher.data?.changelogs ?? [],
    isLoading: fetcher.state !== "idle",
  };
}
