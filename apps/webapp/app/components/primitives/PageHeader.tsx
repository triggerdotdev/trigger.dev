import { ArrowUpRightIcon } from "@heroicons/react/20/solid";
import { Link, useNavigation } from "@remix-run/react";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { UpgradePrompt, useShowUpgradePrompt } from "../billing/v3/UpgradePrompt";
import { BreadcrumbIcon } from "./BreadcrumbIcon";
import { LinkButton } from "./Buttons";
import { Header2 } from "./Headers";
import { LoadingBarDivider } from "./LoadingBarDivider";
import { NamedIcon } from "./NamedIcon";
import { Paragraph } from "./Paragraph";
import { Tabs, TabsProps } from "./Tabs";

type WithChildren = {
  children: React.ReactNode;
  className?: string;
};

export function NavBar({ children }: WithChildren) {
  const organization = useOptionalOrganization();
  const showUpgradePrompt = useShowUpgradePrompt(organization);
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  return (
    <div>
      <div className="grid h-10 w-full grid-rows-[auto_1px] bg-background-bright">
        <div className="flex w-full items-center justify-between pl-3 pr-2">{children}</div>
        <LoadingBarDivider isLoading={isLoading} />
      </div>
      {showUpgradePrompt.shouldShow && organization && <UpgradePrompt />}
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
        <div className="group -ml-1.5 flex items-center gap-0">
          <Link
            to={backButton.to}
            className="rounded px-1.5 py-1 text-xs text-text-dimmed transition group-hover:bg-charcoal-700 group-hover:text-text-bright"
          >
            {backButton.text}
          </Link>
          <BreadcrumbIcon className="h-5" />
        </div>
      )}
      <Header2 className="flex items-center gap-1">{title}</Header2>
    </div>
  );
}

export function PageAccessories({ children }: WithChildren) {
  return <div className="flex items-center gap-2">{children}</div>;
}

export function PageInfoRow({ children, className }: WithChildren) {
  return <div className={cn("flex w-full items-center gap-2", className)}>{children}</div>;
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
    <div className="mb-2 mt-2">
      <Tabs {...props} />
    </div>
  );
}
