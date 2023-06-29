import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  LightBulbIcon,
} from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";
import { Paragraph } from "./Paragraph";
import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
  CheckCircleIcon,
} from "@heroicons/react/24/solid";

const variantClasses = {
  info: {
    className: "border-blue-400/20 bg-blue-400/30",
    icon: <InformationCircleIcon className="h-5 w-5 shrink-0 text-blue-400" />,
    text: "text-blue-200",
  },
  warning: {
    className: "border-yellow-400/20 bg-yellow-400/30",
    icon: (
      <ExclamationCircleIcon className="h-5 w-5 shrink-0 text-yellow-400" />
    ),
    text: "text-yellow-200",
  },
  error: {
    className: "border-[hsl(347,77%,50%)]/30 bg-[hsl(347,77%,50%)]/20",
    icon: (
      <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-rose-400" />
    ),
    text: "text-rose-200",
  },
  idea: {
    className: "border-green-400/20 bg-green-400/30",
    icon: <LightBulbIcon className="h-5 w-5 shrink-0 text-green-400" />,
    text: "text-green-200",
  },
  success: {
    className: "border-green-400/20 bg-green-400/30",
    icon: <CheckCircleIcon className="h-5 w-5 shrink-0 text-green-400" />,
    text: "text-green-200",
  },
  docs: {
    className:
      "border-blue-400/20 bg-blue-400/30 transition hover:bg-blue-400/40",
    icon: <BookOpenIcon className="h-5 w-5 shrink-0 text-blue-400" />,
    text: "text-blue-200",
  },
} as const;

export function Callout({
  children,
  className,
  icon,
  variant,
  href,
}: {
  children?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
  variant: keyof typeof variantClasses;
  href?: string;
}) {
  const variantDefinition = variantClasses[variant];

  if (variant === "docs") {
    return (
      <a
        href={href}
        target="_blank"
        className={cn(
          `flex w-full items-start justify-between gap-2.5 rounded-md border py-2 pl-2 pr-3 shadow-md backdrop-blur-sm`,
          variantDefinition.className,
          className
        )}
      >
        <div className="flex w-full items-start gap-x-2">
          {icon ? icon : variantDefinition.icon}

          {typeof children === "string" ? (
            <Paragraph variant={"small"} className={variantDefinition.text}>
              {children}
            </Paragraph>
          ) : (
            children
          )}
        </div>
        <ArrowTopRightOnSquareIcon className="h-5 w-5 text-blue-400" />
      </a>
    );
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
        <Paragraph variant={"small"} className={variantDefinition.text}>
          {children}
        </Paragraph>
      ) : (
        children
      )}
    </div>
  );
}
