import { RouteMatch, useMatches } from "@remix-run/react";
import { Fragment, ReactNode } from "react";
import { BreadcrumbIcon } from "../primitives/BreadcrumbIcon";

export type BreadcrumbItem = (
  match: RouteMatch,
  allMatches: RouteMatch[]
) => ReactNode;

export function Breadcrumb() {
  const matches = useMatches();

  return (
    <div className="hidden items-center md:flex">
      {matches.map((match) => {
        if (!match.handle || !match.handle.breadcrumb) return null;

        const breadcrumb = match.handle.breadcrumb as BreadcrumbItem;

        return (
          <Fragment key={match.id}>
            <BreadcrumbIcon />
            {breadcrumb(match, matches)}
          </Fragment>
        );
      })}
    </div>
  );
}
