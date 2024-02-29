import { ArrowUpRightIcon } from "@heroicons/react/20/solid";
import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { plansPath } from "~/utils/pathBuilder";
import { UpgradePrompt, useShowUpgradePrompt } from "../billing/UpgradePrompt";
import { PageNavigationIndicator } from "../navigation/PageNavigationIndicator";
import { BreadcrumbIcon } from "./BreadcrumbIcon";
import { LinkButton } from "./Buttons";
import { Header2, Header3 } from "./Headers";
import { NamedIcon } from "./NamedIcon";
import { Paragraph } from "./Paragraph";
import { Tabs, TabsProps } from "./Tabs";

type WithChildren = {
  children: React.ReactNode;
};

export function NavBar({ children }: WithChildren) {
  const organization = useOptionalOrganization();
  const showUpgradePrompt = useShowUpgradePrompt(organization);

  return (
    <div>
      <div className="flex h-10 w-full items-center border-b border-grid-bright bg-background-bright pl-3 pr-1">
        <div className="flex grow items-center justify-between">{children}</div>
        <div className="flex h-full items-center gap-4">
          <PageNavigationIndicator className="mr-2" />
        </div>
      </div>
      {showUpgradePrompt.shouldShow && organization && (
        <UpgradePrompt
          runsEnabled={showUpgradePrompt.runsEnabled}
          runCountCap={showUpgradePrompt.runCountCap}
          planPath={plansPath(organization)}
        />
      )}
    </div>
  );
}

type PageTitleProps = {
  title: string;
  backButton?: {
    to: string;
    text: string;
  };
};

export function PageTitle({ title, backButton }: PageTitleProps) {
  return (
    <div className="flex items-center gap-2">
      {backButton && (
        <div className="group flex items-center gap-2">
          <Link
            to={backButton.to}
            className="flex items-center gap-1 text-charcoal-400 transition group-hover:text-white"
          >
            <ChevronLeftIcon className="h-6" />
            <Header3 textColor="dimmed" className="transition group-hover:text-white">
              {backButton.text}
            </Header3>
          </Link>
          <BreadcrumbIcon className="h-6" />
        </div>
      )}
      <Header2 className="flex items-center gap-1">{title}</Header2>
    </div>
  );
}

export function PageAccessories({ children }: WithChildren) {
  return <div className="flex items-center gap-3">{children}</div>;
}

export function PageInfoRow({ children }: WithChildren) {
  return <div className="flex w-full items-center gap-2">{children}</div>;
}

export function PageInfoGroup({
  children,
  alignment = "left",
}: WithChildren & { alignment?: "left" | "right" }) {
  return (
    <div
      className={cn(
        "flex grow flex-wrap items-center gap-x-4 gap-y-1",
        alignment === "right" && "justify-end"
      )}
    >
      {children}
    </div>
  );
}

export function PageInfoProperty({
  icon,
  label,
  value,
  to,
}: {
  icon?: string | React.ReactNode;
  label?: string;
  value?: React.ReactNode;
  to?: string;
}) {
  if (to === undefined) {
    return <PageInfoPropertyContent icon={icon} label={label} value={value} />;
  }

  return (
    <LinkButton variant="tertiary/small" to={to} TrailingIcon={ArrowUpRightIcon}>
      <PageInfoPropertyContent icon={icon} label={label} value={value} />
    </LinkButton>
  );
}

function PageInfoPropertyContent({
  icon,
  label,
  value,
}: {
  icon?: string | React.ReactNode;
  label?: string;
  value?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      {icon && typeof icon === "string" ? <NamedIcon name={icon} className="h-4 w-4" /> : icon}
      {label && (
        <Paragraph variant="extra-small/caps" className="mt-0.5 whitespace-nowrap">
          {label}
          {value !== undefined && ":"}
        </Paragraph>
      )}
      {value !== undefined && <Paragraph variant="small">{value}</Paragraph>}
    </div>
  );
}

export function PageTabs(props: TabsProps) {
  return (
    <div className="mt-2">
      <Tabs {...props} />
    </div>
  );
}
