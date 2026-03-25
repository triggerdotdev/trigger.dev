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
  ChartBarIcon,
  CheckCircleIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { Paragraph } from "./Paragraph";
import { Spinner } from "./Spinner";

export const variantClasses = {
  info: {
    className: "border-charcoal-700 bg-charcoal-800",
    icon: <InformationCircleIcon className="h-5 w-5 shrink-0 text-text-dimmed" />,
    textColor: "text-text-bright",
    linkClassName: "transition hover:bg-charcoal-750",
  },
  warning: {
    className: "border-warning/20 bg-warning/10",
    icon: <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-warning" />,
    textColor: "text-yellow-200",
    linkClassName: "transition hover:bg-warning/20",
  },
  error: {
    className: "border-error/20 bg-error/10",
    icon: <ExclamationCircleIcon className="h-5 w-5 shrink-0 text-error" />,
    textColor: "text-rose-200",
    linkClassName: "transition hover:bg-error/20",
  },
  idea: {
    className: "border-success/20 bg-success/10",
    icon: <LightBulbIcon className="h-5 w-5 shrink-0 text-success" />,
    textColor: "text-green-200",
    linkClassName: "transition hover:bg-success/20",
  },
  success: {
    className: "border-success/20 bg-success/10",
    icon: <CheckCircleIcon className="h-5 w-5 shrink-0 text-success" />,
    textColor: "text-green-200",
    linkClassName: "transition hover:bg-success/20",
  },
  docs: {
    className: "border-blue-400/20 bg-blue-400/10",
    icon: <BookOpenIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />,
    textColor: "text-blue-200",
    linkClassName: "transition hover:bg-blue-400/20",
  },
  pending: {
    className: "border-blue-400/20 bg-blue-800/30",
    icon: <Spinner className="h-5 w-5 shrink-0 " />,
    textColor: "text-blue-300",
    linkClassName: "transition hover:bg-blue-400/20",
  },
  pricing: {
    className: "border-indigo-400/20 bg-indigo-800/30",
    icon: <CreditCardIcon className="h-5 w-5 shrink-0 text-indigo-400" />,
    textColor: "text-indigo-300",
    linkClassName: "transition hover:bg-indigo-400/20",
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
            `flex w-full items-start justify-between gap-2.5 rounded-md border py-2 pl-2 pr-3 shadow-md backdrop-blur-sm`,
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
            `flex w-full items-start justify-between gap-2.5 rounded-md border py-2 pl-2 pr-3 shadow-md backdrop-blur-sm`,
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
        "flex w-full items-start gap-2 rounded-md border pl-2 pr-2 shadow-md backdrop-blur-sm",
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
