import { useCallback, useState } from "react";
import { useOptimisticLocation } from "./useOptimisticLocation";
import type { Location } from "@remix-run/react";

export function useReplaceLocation() {
  const optimisticLocation = useOptimisticLocation();
  const [location, setLocation] = useState(optimisticLocation);

  const replaceLocation = useCallback((location: Location<any>) => {
    const fullPath = location.pathname + location.search + location.hash;
    //replace the URL in the browser
    history.replaceState(null, "", fullPath);
    //update the state (new object in case the same location ref was modified)
    const newLocation = { ...location };
    setLocation(newLocation);
  }, []);

  const replaceSearchParam = useCallback(
    (key: string, value?: string) => {
      const searchParams = new URLSearchParams(location.search);
      if (value) {
        searchParams.set(key, value);
      } else {
        searchParams.delete(key);
      }
      replaceLocation({ ...optimisticLocation, search: "?" + searchParams.toString() });
    },
    [optimisticLocation, replaceLocation]
  );

  return { location, replaceLocation, replaceSearchParam };
}
