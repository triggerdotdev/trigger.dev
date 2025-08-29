import { useNavigate } from "@remix-run/react";
import { useOptimisticLocation } from "./useOptimisticLocation";
import { useCallback } from "react";

type Values = Record<string, string | string[] | undefined>;

export function useSearchParams() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();

  const replace = useCallback(
    (values: Values) => {
      const s = set(new URLSearchParams(location.search), values);
      navigate(`${location.pathname}?${s.toString()}`, { replace: true });
    },
    [location, navigate]
  );

  const del = useCallback(
    (keys: string | string[]) => {
      const search = new URLSearchParams(location.search);
      if (!Array.isArray(keys)) {
        keys = [keys];
      }
      for (const key of keys) {
        search.delete(key);
      }
      navigate(`${location.pathname}?${search.toString()}`, { replace: true });
    },
    [location, navigate]
  );

  const value = useCallback(
    (param: string) => {
      const search = new URLSearchParams(location.search);
      const val = search.get(param) ?? undefined;
      if (val === undefined) {
        return val;
      }

      return decodeURIComponent(val);
    },
    [location]
  );

  const values = useCallback(
    (param: string) => {
      const search = new URLSearchParams(location.search);
      const all = search.getAll(param);
      return all.map((v) => decodeURIComponent(v));
    },
    [location]
  );

  const has = useCallback(
    (param: string) => {
      const search = new URLSearchParams(location.search);
      return search.has(param);
    },
    [location]
  );

  return {
    value,
    values,
    replace,
    del,
    has,
  };
}

function set(searchParams: URLSearchParams, values: Values) {
  const search = new URLSearchParams(searchParams);
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

  return search;
}
