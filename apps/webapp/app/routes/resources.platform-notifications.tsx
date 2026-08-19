import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, type ShouldRevalidateFunction } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { useLatest } from "react-use";
import { requireUserId } from "~/services/session.server";
import {
  getActivePlatformNotifications,
  verifyOrgMembership,
  type PlatformNotificationWithPayload,
} from "~/services/platformNotifications.server";

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export type PlatformNotificationsLoaderData = {
  notifications: PlatformNotificationWithPayload[];
  unreadCount: number;
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

  if (!organizationId) {
    return json<PlatformNotificationsLoaderData>({ notifications: [], unreadCount: 0 });
  }

  const result = await getActivePlatformNotifications({ userId, organizationId, projectId });

  return json<PlatformNotificationsLoaderData>(result);
}

const POLL_INTERVAL_MS = 60000; // 1 minute

export function usePlatformNotifications(organizationId: string, projectId: string) {
  const fetcher = useFetcher<typeof loader>();
  const { load, state } = fetcher;
  const stateRef = useLatest(state);
  const lastLoadedUrl = useRef<string | null>(null);
  const url = `/resources/platform-notifications?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`;

  useEffect(() => {
    if (lastLoadedUrl.current !== url && state === "idle") {
      lastLoadedUrl.current = url;
      load(url);
    }
  }, [load, state, url]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (stateRef.current === "idle") {
        load(url);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [load, stateRef, url]);

  return {
    notifications: fetcher.data?.notifications ?? [],
    unreadCount: fetcher.data?.unreadCount ?? 0,
    isLoading: fetcher.state !== "idle",
  };
}
