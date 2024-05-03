import { useNavigate } from "@remix-run/react";
import { useOptimisticLocation } from "./useOptimisticLocation";
import { useCallback } from "react";

export function useSearchParam(param: string) {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const search = new URLSearchParams(location.search);

  const set = useCallback(
    (value: string | string[]) => {
      if (typeof value === "string") {
        search.set(param, value);
      } else {
        search.delete(param);
        for (const v of value) {
          search.append(param, v);
        }
      }
    },
    [location, search, param]
  );

  const replace = useCallback(
    (value: string | string[]) => {
      set(value);
      navigate(`${location.pathname}?${search.toString()}`, { replace: true });
    },
    [location, search, param]
  );

  const del = useCallback(() => {
    search.delete(param);
    navigate(`${location.pathname}?${search.toString()}`, { replace: true });
  }, [location, search, param]);

  return {
    value: search.get(param),
    values: search.getAll(param),
    set,
    replace,
    del,
  };
}
