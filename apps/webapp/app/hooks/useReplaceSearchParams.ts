import { useSearchParams } from "@remix-run/react";
import { useCallback } from "react";

export function useReplaceSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const replaceSearchParam = useCallback(
    (key: string, value?: string) => {
      setSearchParams((s) => {
        if (value) {
          s.set(key, value);
        } else {
          s.delete(key);
        }
        return s;
      });
    },
    [searchParams]
  );

  return { searchParams, setSearchParams, replaceSearchParam };
}
