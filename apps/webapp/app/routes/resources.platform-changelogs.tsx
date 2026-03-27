import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, type ShouldRevalidateFunction } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { requireUserId } from "~/services/session.server";
import { getRecentChangelogs } from "~/services/platformNotifications.server";

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export type PlatformChangelogsLoaderData = {
  changelogs: Array<{ id: string; title: string; actionUrl?: string }>;
};

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUserId(request);

  const changelogs = await getRecentChangelogs();

  return json<PlatformChangelogsLoaderData>({ changelogs });
}

const POLL_INTERVAL_MS = 60_000;

export function useRecentChangelogs() {
  const fetcher = useFetcher<typeof loader>();
  const hasInitiallyFetched = useRef(false);

  useEffect(() => {
    const url = "/resources/platform-changelogs";

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
  }, []);

  return {
    changelogs: fetcher.data?.changelogs ?? [],
    isLoading: fetcher.state !== "idle",
  };
}
