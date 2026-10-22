import { useFetcher } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { useTypedLoaderData } from "remix-typedjson";
import type { loader } from "~/root";
import { TIMEZONE_ACTION_PATH } from "~/utils/flashedErrorRevalidation";

export function TimezoneSetter() {
  const { timezone: storedTimezone } = useTypedLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const hasSetTimezone = useRef(false);

  useEffect(() => {
    if (hasSetTimezone.current) return;

    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (browserTimezone && browserTimezone !== storedTimezone) {
      hasSetTimezone.current = true;
      fetcher.submit(
        { timezone: browserTimezone },
        {
          method: "POST",
          action: TIMEZONE_ACTION_PATH,
          encType: "application/json",
        }
      );
    }
  }, [storedTimezone, fetcher]);

  return null;
}
