import { UIMatch, useMatches } from "@remix-run/react";
import { Fragment, ReactNode } from "react";
import { BreadcrumbIcon } from "../primitives/BreadcrumbIcon";
import { Handle } from "~/utils/handle";
import { LinkButton } from "../primitives/Buttons";

export type BreadcrumbItem = (match: UIMatch, allMatches: UIMatch[]) => ReactNode;

export function Breadcrumb() {
  const matches = useMatches() as UIMatch<unknown, Handle>[];

  return (
    <div className="flex items-center px-1">
      {matches
        .filter((b) => b.handle && b.handle.breadcrumb)
        .map((match, index) => {
          const breadcrumb = match.handle.breadcrumb as BreadcrumbItem;

          return (
            <Fragment key={match.id}>
              {index !== 0 && <BreadcrumbIcon />} {breadcrumb(match, matches)}
            </Fragment>
          );
        })}
    </div>
  );
}

export function BreadcrumbLink({ title, to }: { title: string; to: string }) {
  return (
    <LinkButton to={to} variant="tertiary/small">
      {title}
    </LinkButton>
  );
}
