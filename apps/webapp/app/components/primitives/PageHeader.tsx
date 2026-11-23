import { ChevronLeftIcon } from "@heroicons/react/20/solid";
import { Link, useNavigation } from "@remix-run/react";
import { type ReactNode } from "react";
import { QuestionMarkIcon } from "~/assets/icons/QuestionMarkIcon";
import { cn } from "~/utils/cn";
import { OrgBanner } from "../billing/OrgBanner";
import { SecurityNoticeBanner } from "../securityNotices/SecurityNoticeBanner";
import { BreadcrumbIcon } from "./BreadcrumbIcon";
import { Header2 } from "./Headers";
import { LoadingBarDivider } from "./LoadingBarDivider";
import { SimpleTooltip } from "./Tooltip";
import { DashboardAgentLauncher } from "../dashboard-agent/dashboardAgentLauncher";
import { FavoritePageButton } from "../navigation/FavoritePageButton";

type WithChildren = {
  children: React.ReactNode;
  className?: string;
};

export function NavBar({ children }: WithChildren) {
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  return (
    <div>
      <div className="grid h-10 w-full grid-rows-[auto_1px] bg-background-bright">
        <div className="flex w-full items-center gap-2 pl-3 pr-2">
          <div className="flex flex-1 items-center justify-between">{children}</div>
          <DashboardAgentLauncher />
        </div>
        <LoadingBarDivider isLoading={isLoading} />
      </div>
      <SecurityNoticeBanner />
      <OrgBanner />
    </div>
  );
}

type PageTitleProps = {
  /** Omit to show only the back link (a detail page whose header carries the title). */
  title?: ReactNode;
  /** The name a favorite of this page gets; defaults to `title` when that's a string. */
  favoriteTitle?: string;
  backButton?: {
    to: string;
    text: string;
  };
  /** Crumbs before the back link, outermost first, e.g. Tasks before a task. */
  parentCrumbs?: Array<{ to: string; text: string }>;
  /**
   * Renders to the right of the title.
   * - Pass a string → a question-mark icon with the string as its hover tooltip.
   * - Pass a ReactNode → rendered verbatim, for custom adornments.
   */
  accessory?: ReactNode;
};

// Plain text links, so a crumb's label sits in the same place whether it's a link or not.
const crumbLinkClassName =
  "text-text-dimmed underline-offset-2 transition focus-custom hover:text-text-bright hover:underline";

export function PageTitle({
  title,
  favoriteTitle,
  backButton,
  parentCrumbs,
  accessory,
}: PageTitleProps) {
  const titleText = favoriteTitle ?? (typeof title === "string" ? title : undefined);
  const hasTitle = title !== undefined && title !== null && title !== "";

  return (
    <div className="flex items-center gap-1.5">
      {hasTitle && backButton
        ? parentCrumbs?.map((crumb) => (
            <div key={crumb.to} className="flex items-center gap-1.5">
              <Link to={crumb.to} className={cn("text-xs", crumbLinkClassName)}>
                {crumb.text}
              </Link>
              <BreadcrumbIcon className="h-5" />
            </div>
          ))
        : null}
      {backButton && (
        <div className="flex items-center gap-1.5">
          <Link
            to={backButton.to}
            className={
              hasTitle
                ? cn("text-xs", crumbLinkClassName)
                : cn("flex items-center gap-0.5 text-sm", crumbLinkClassName)
            }
          >
            {hasTitle ? null : <ChevronLeftIcon className="size-4" />}
            {backButton.text}
          </Link>
          {hasTitle ? <BreadcrumbIcon className="h-5" /> : null}
        </div>
      )}
      {hasTitle ? <Header2 className="flex items-center gap-1">{title}</Header2> : null}
      {accessory !== undefined && (
        // ml-px optically evens the accessory against the title's tight text edge
        <span className="ml-px flex items-center">
          {typeof accessory === "string" ? (
            <SimpleTooltip
              button={<QuestionMarkIcon className="size-4 text-text-dimmed" />}
              content={accessory}
              className="max-w-xs"
              disableHoverableContent
            />
          ) : (
            accessory
          )}
        </span>
      )}
      {/* -ml-1 pulls the star's button box near-flush: its inner padding then provides the
          visual gap, matching the title-to-accessory spacing while hovered */}
      <FavoritePageButton pageTitle={titleText} className="-ml-1" />
    </div>
  );
}

export function PageAccessories({ children }: WithChildren) {
  return <div className="flex items-center gap-2">{children}</div>;
}
