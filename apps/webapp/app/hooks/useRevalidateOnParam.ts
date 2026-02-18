import { useEffect } from "react";
import { useRevalidator, useSearchParams } from "@remix-run/react";

type UseRevalidateOnParamOptions = {
  /** The query param(s) that trigger revalidation */
  param: string | string[];
  /** Callback fired when revalidation is triggered */
  onRevalidate?: () => void;
};

/**
 * Hook that triggers revalidation when specific query params are present,
 * then removes those params from the URL.
 *
 * Usage:
 * ```ts
 * // Revalidate when ?_revalidate is present
 * useRevalidateOnParam({ param: "_revalidate" });
 *
 * // With callback to close a modal
 * useRevalidateOnParam({
 *   param: "_revalidate",
 *   onRevalidate: () => setEditorMode(null),
 * });
 * ```
 *
 * The redirect should include the param:
 * ```ts
 * return redirect(`${dashboardPath}?_revalidate=${Date.now()}`);
 * ```
 */
export function useRevalidateOnParam({ param, onRevalidate }: UseRevalidateOnParamOptions) {
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();

  const paramArray = Array.isArray(param) ? param : [param];

  useEffect(() => {
    // Check if any of the trigger params are present
    const hasParam = paramArray.some((p) => searchParams.has(p));

    if (hasParam) {
      // Trigger revalidation
      revalidator.revalidate();

      // Call the callback if provided
      onRevalidate?.();

      // Remove the trigger params from the URL
      const newParams = new URLSearchParams(searchParams);
      paramArray.forEach((p) => newParams.delete(p));

      // Update URL without the params (replace to avoid adding to history)
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams, revalidator, paramArray, onRevalidate]);
}
