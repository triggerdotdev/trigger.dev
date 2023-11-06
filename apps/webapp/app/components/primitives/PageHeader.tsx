import { Link } from "@remix-run/react";
import { Header1 } from "./Headers";
import { BreadcrumbIcon } from "./BreadcrumbIcon";
import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import { Paragraph } from "./Paragraph";
import { cn } from "~/utils/cn";
import { NamedIcon } from "./NamedIcon";
import { Tabs, TabsProps } from "./Tabs";
import { Icon, RenderIcon } from "./Icon";
import { Button, LinkButton } from "./Buttons";
import { ArrowUpRightIcon } from "@heroicons/react/20/solid";

type WithChildren = {
  children: React.ReactNode;
};

export function PageHeader({ children, hideBorder }: WithChildren & { hideBorder?: boolean }) {
  return (
    <div className={cn("mx-4 pt-4", hideBorder ? "" : "border-b border-ui-border pb-4")}>
      {children}
    </div>
  );
}

export function PageTitleRow({ children }: WithChildren) {
  return <div className="flex items-center justify-between">{children}</div>;
}

type PageTitleProps = {
  icon?: RenderIcon;
  title: string;
  backButton?: {
    to: string;
    text: string;
  };
};

export function PageTitle({ icon, title, backButton }: PageTitleProps) {
  return (
    <div className="flex items-center gap-2">
      {backButton && (
        <div className="group flex items-center gap-2">
          <Link
            to={backButton.to}
            className="flex items-center gap-1 text-slate-400 transition group-hover:text-white"
          >
            <ChevronLeftIcon className="h-6" />
            <Header1 textColor="dimmed" className="transition group-hover:text-white">
              {backButton.text}
            </Header1>
          </Link>
          <BreadcrumbIcon className="h-6" />
        </div>
      )}
      <Header1 className="flex items-center gap-1">
        {icon && <Icon icon={icon} className="h-5 w-5" />}
        {title}
      </Header1>
    </div>
  );
}

export function PageButtons({ children }: WithChildren) {
  return <div className="flex items-center gap-3">{children}</div>;
}

export function PageDescription({ children }: WithChildren) {
  return (
    <Paragraph variant="small" className="mb-0 mt-2">
      {children}
    </Paragraph>
  );
}

export function PageInfoRow({ children }: WithChildren) {
  return <div className="mt-2 flex w-full items-center gap-2">{children}</div>;
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
  value: React.ReactNode;
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
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      {icon && typeof icon === "string" ? <NamedIcon name={icon} className="h-4 w-4" /> : icon}
      {label && (
        <Paragraph variant="extra-small/caps" className="mt-0.5 whitespace-nowrap">
          {label}:
        </Paragraph>
      )}
      <Paragraph variant="small">{value}</Paragraph>
    </div>
  );
}

export function PageTabs(props: TabsProps) {
  return (
    <div className="mt-4">
      <Tabs {...props} />
    </div>
  );
}
