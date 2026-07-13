import {
  CreditCardIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  LightBulbIcon,
} from "@heroicons/react/20/solid";
import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { Paragraph } from "./Paragraph";
import { Spinner } from "./Spinner";

export const variantClasses = {
  info: {
    className: "border-grid-bright bg-background-bright",
    icon: <InformationCircleIcon className="h-5 w-5 shrink-0 text-text-dimmed" />,
    textColor: "text-text-bright",
    linkClassName: "transition hover:bg-background-hover",
  },
  warning: {
    className: "border-warning/20 bg-warning/10",
    icon: <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-warning" />,
    textColor: "text-callout-warning-text",
    linkClassName: "transition hover:bg-warning/20",
  },
  error: {
    className: "border-error/20 bg-error/10",
    icon: <ExclamationCircleIcon className="h-5 w-5 shrink-0 text-error" />,
    textColor: "text-callout-error-text",
    linkClassName: "transition hover:bg-error/20",
  },
  idea: {
    className: "border-success/20 bg-success/10",
    icon: <LightBulbIcon className="h-5 w-5 shrink-0 text-success" />,
    textColor: "text-callout-success-text",
    linkClassName: "transition hover:bg-success/20",
  },
  success: {
    className: "border-success/20 bg-success/10",
    icon: <CheckCircleIcon className="h-5 w-5 shrink-0 text-success" />,
    textColor: "text-callout-success-text",
    linkClassName: "transition hover:bg-success/20",
  },
  docs: {
    className: "border-callout-docs/20 bg-callout-docs/10",
    icon: <BookOpenIcon className="mt-0.5 h-5 w-5 shrink-0 text-callout-docs" />,
    textColor: "text-callout-docs-text",
    linkClassName: "transition hover:bg-callout-docs/20",
  },
  pending: {
    className: "border-callout-pending/20 bg-callout-pending-bg/30",
    icon: <Spinner className="h-5 w-5 shrink-0 " />,
    textColor: "text-callout-pending-text",
    linkClassName: "transition hover:bg-callout-pending/20",
  },
  pricing: {
    className: "border-callout-pricing/20 bg-callout-pricing-bg/30",
    icon: <CreditCardIcon className="h-5 w-5 shrink-0 text-callout-pricing" />,
    textColor: "text-callout-pricing-text",
    linkClassName: "transition hover:bg-callout-pricing/20",
  },
} as const;

export type CalloutVariant = keyof typeof variantClasses;

export function Callout({
  children,
  className,
  icon,
  cta,
  variant,
  to,
}: {
  children?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
  cta?: React.ReactNode;
  variant: CalloutVariant;
  to?: string;
}) {
  const variantDefinition = variantClasses[variant];

  if (to !== undefined) {
    if (to.startsWith("http")) {
      return (
        <a
          href={to}
          target="_blank"
          className={cn(
            `flex w-full items-start justify-between gap-2.5 rounded-md border py-2 pl-2 pr-3 shadow-md backdrop-blur-xs`,
            variantDefinition.className,
            variantDefinition.linkClassName,
            className
          )}
        >
          <div className={"flex w-full items-start gap-x-2"}>
            {icon ? icon : variantDefinition.icon}

            {typeof children === "string" ? (
              <Paragraph variant={"small"} className={variantDefinition.textColor}>
                {children}
              </Paragraph>
            ) : (
              children
            )}
          </div>
          <ArrowTopRightOnSquareIcon className={cn("h-5 w-5", variantDefinition.textColor)} />
        </a>
      );
    } else {
      return (
        <Link
          to={to}
          className={cn(
            `flex w-full items-start justify-between gap-2.5 rounded-md border py-2 pl-2 pr-3 shadow-md backdrop-blur-xs`,
            variantDefinition.className,
            variantDefinition.linkClassName,
            className
          )}
        >
          <div className={"flex w-full items-start gap-x-2"}>
            {icon ? icon : variantDefinition.icon}

            {typeof children === "string" ? (
              <Paragraph variant={"small"} className={variantDefinition.textColor}>
                {children}
              </Paragraph>
            ) : (
              children
            )}
          </div>
          <div className="flex h-full items-center">
            <ChevronRightIcon className={cn("h-5 w-5", variantDefinition.textColor)} />
          </div>
        </Link>
      );
    }
  }

  return (
    <div
      className={cn(
        "flex w-full items-start gap-2 rounded-md border pl-2 pr-2 shadow-md backdrop-blur-xs",
        cta ? "py-2" : "py-2.5",
        variantDefinition.className,
        className
      )}
    >
      <div className={cn(`flex w-full items-start gap-2.5`)}>
        {icon ? icon : variantDefinition.icon}

        {typeof children === "string" ? (
          <Paragraph variant={"small"} className={variantDefinition.textColor}>
            {children}
          </Paragraph>
        ) : (
          <span>{children}</span>
        )}
      </div>
      {cta && cta}
    </div>
  );
}
