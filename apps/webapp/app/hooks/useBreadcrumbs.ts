import { useMatches } from "@remix-run/react";
import type { ReactNode } from "react";

type BreadcrumbFn = () => ReactNode;

export function useBreadcrumbs(): BreadcrumbFn[] {
  const matches = useMatches();

  return matches
    .filter((match) => match.handle)
    .filter((match) => match.handle!.breadcrumb)
    .map((match) => match.handle!.breadcrumb as BreadcrumbFn);
}
