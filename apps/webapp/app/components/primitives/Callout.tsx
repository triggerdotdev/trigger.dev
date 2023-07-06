import {
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

export const variantClasses = {
  info: {
    className: "border-blue-400/20 bg-blue-400/30",
    icon: <InformationCircleIcon className="h-5 w-5 shrink-0 text-blue-400" />,
    textColor: "text-blue-200",
    linkClassName: "transition hover:bg-blue-400/40",
  },
  warning: {
    className: "border-yellow-400/20 bg-yellow-400/30",
    icon: (
      <ExclamationCircleIcon className="h-5 w-5 shrink-0 text-yellow-400" />
    ),
    textColor: "text-yellow-200",
    linkClassName: "transition hover:bg-yellow-400/40",
  },
  error: {
    className: "border-rose-500/20 bg-rose-500/30",
    icon: (
      <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-rose-400" />
    ),
    textColor: "text-rose-200",
    linkClassName: "transition hover:bg-rose-500/40",
  },
  idea: {
    className: "border-green-400/20 bg-green-400/30",
    icon: <LightBulbIcon className="h-5 w-5 shrink-0 text-green-400" />,
    textColor: "text-green-200",
    linkClassName: "transition hover:bg-green-400/40",
  },
  success: {
    className: "border-green-400/20 bg-green-400/30",
    icon: <CheckCircleIcon className="h-5 w-5 shrink-0 text-green-400" />,
    textColor: "text-green-200",
    linkClassName: "transition hover:bg-green-400/40",
  },
  docs: {
    className: "border-blue-400/20 bg-blue-400/30",
    icon: <BookOpenIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />,
    textColor: "text-blue-200",
    linkClassName: "transition hover:bg-blue-400/40",
  },
} as const;

export function Callout({
  children,
  className,
  icon,
  variant,
  to,
}: {
  children?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
  variant: keyof typeof variantClasses;
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
              <Paragraph
                variant={"small"}
                className={variantDefinition.textColor}
              >
                {children}
              </Paragraph>
            ) : (
              children
            )}
          </div>
          <ArrowTopRightOnSquareIcon
            className={cn("h-5 w-5", variantDefinition.textColor)}
          />
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
              <Paragraph
                variant={"small"}
                className={variantDefinition.textColor}
              >
                {children}
              </Paragraph>
            ) : (
              children
            )}
          </div>
          <ChevronRightIcon
            className={cn("h-5 w-5", variantDefinition.textColor)}
          />
        </Link>
      );
    }
  }

  return (
    <div
      className={cn(
        `flex w-full items-start gap-2.5 rounded-md border py-2 pl-2 pr-3 shadow-md backdrop-blur-sm`,
        variantDefinition.className,
        className
      )}
    >
      {icon ? icon : variantDefinition.icon}

      {typeof children === "string" ? (
        <Paragraph variant={"small"} className={variantDefinition.textColor}>
          {children}
        </Paragraph>
      ) : (
        children
      )}
    </div>
  );
}
