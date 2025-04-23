import { useSearchParams } from "@remix-run/react";
import { useCallback } from "react";

type NavigateOptions = {
  replace?: boolean;
  preventScrollReset?: boolean;
};

export function useReplaceSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const replaceSearchParam = useCallback(
    (key: string, value?: string, navigateOpts?: NavigateOptions) => {
      setSearchParams((s) => {
        if (value) {
          s.set(key, value);
        } else {
          s.delete(key);
        }
        return s;
      }, navigateOpts);
    },
    [searchParams]
  );

  return { searchParams, setSearchParams, replaceSearchParam };
}
