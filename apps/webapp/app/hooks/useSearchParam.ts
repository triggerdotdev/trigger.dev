import { useNavigate } from "@remix-run/react";
import { useOptimisticLocation } from "./useOptimisticLocation";
import { useCallback } from "react";

type Values = Record<string, string | string[] | undefined>;

export function useSearchParams() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const search = new URLSearchParams(location.search);

  const set = useCallback(
    (values: Values) => {
      for (const [param, value] of Object.entries(values)) {
        if (value === undefined) {
          search.delete(param);
          continue;
        }

        if (typeof value === "string") {
          search.set(param, value);
          continue;
        }

        search.delete(param);
        for (const v of value) {
          search.append(param, v);
        }
      }
    },
    [location, search]
  );

  const replace = useCallback(
    (values: Values) => {
      set(values);
      navigate(`${location.pathname}?${search.toString()}`, { replace: true });
    },
    [location, search]
  );

  const del = useCallback(
    (keys: string | string[]) => {
      if (!Array.isArray(keys)) {
        keys = [keys];
      }
      for (const key of keys) {
        search.delete(key);
      }
      navigate(`${location.pathname}?${search.toString()}`, { replace: true });
    },
    [location, search]
  );

  const value = useCallback(
    (param: string) => {
      return search.get(param) ?? undefined;
    },
    [location, search]
  );

  const values = useCallback(
    (param: string) => {
      return search.getAll(param);
    },
    [location, search]
  );

  return {
    value,
    values,
    set,
    replace,
    del,
  };
}
