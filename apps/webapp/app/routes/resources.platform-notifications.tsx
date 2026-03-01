import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, type ShouldRevalidateFunction } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { requireUserId } from "~/services/session.server";
import {
  getActivePlatformNotifications,
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
  const organizationId = url.searchParams.get("organizationId");
  const projectId = url.searchParams.get("projectId") ?? undefined;

  if (!organizationId) {
    return json<PlatformNotificationsLoaderData>({ notifications: [], unreadCount: 0 });
  }

  const result = await getActivePlatformNotifications({ userId, organizationId, projectId });

  return json<PlatformNotificationsLoaderData>(result);
}

const POLL_INTERVAL_MS = 60_000; // 1 minute

export function usePlatformNotifications(organizationId: string, projectId: string) {
  const fetcher = useFetcher<typeof loader>();
  const hasInitiallyFetched = useRef(false);

  useEffect(() => {
    const url = `/resources/platform-notifications?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`;

    if (!hasInitiallyFetched.current && fetcher.state === "idle") {
      hasInitiallyFetched.current = true;
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
    notifications: fetcher.data?.notifications ?? [],
    unreadCount: fetcher.data?.unreadCount ?? 0,
    isLoading: fetcher.state !== "idle",
  };
}
