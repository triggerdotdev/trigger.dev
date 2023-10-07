import { UIMatch, useMatches, Params } from "@remix-run/react";
import { Fragment, ReactNode } from "react";
import { BreadcrumbIcon } from "../primitives/BreadcrumbIcon";
import { Handle } from "~/utils/handle";

export type BreadcrumbItem = (
  match: UIMatch<unknown, Handle>,
  allMatches: UIMatch<unknown, Handle>[]
) => ReactNode;

export function Breadcrumb() {
  const matches = useMatches() as UIMatch<unknown, Handle>[];

  return (
    <div className="hidden items-center md:flex">
      {matches.map((match) => {
        if (!match.handle || !match.handle?.breadcrumb) return null;

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
