import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  LightBulbIcon,
} from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";
import { Paragraph } from "./Paragraph";

const variantClasses = {
  info: {
    className: "border-blue-400/20 bg-blue-400/30",
    icon: <InformationCircleIcon className="h-5 w-5 text-blue-400" />,
    text: "text-blue-200",
  },
  warning: {
    className: "border-yellow-400/20 bg-yellow-400/30",
    icon: <ExclamationCircleIcon className="h-5 w-5 text-yellow-400" />,
    text: "text-yellow-200",
  },
  error: {
    className: "border-rose-400/20 bg-rose-400/30",
    icon: <ExclamationTriangleIcon className="h-5 w-5 text-rose-400" />,
    text: "text-rose-200",
  },
  idea: {
    className: "border-green-400/20 bg-green-400/30",
    icon: <LightBulbIcon className="h-5 w-5 text-green-400" />,
    text: "text-green-200",
  },
} as const;

export function Callout({
  children,
  className,
  icon,
  variant,
}: {
  children?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
  variant: keyof typeof variantClasses;
}) {
  const variantDefinition = variantClasses[variant];

  return (
    <div
      className={cn(
        `flex w-full gap-4 rounded-md border py-3 pl-3 pr-4 shadow-md backdrop-blur-sm`,
        variantDefinition.className,
        className
      )}
    >
      <div className="flex items-center justify-start gap-2.5">
        {icon ? icon : variantDefinition.icon}
        <Paragraph variant={"small"} className={variantDefinition.text}>
          {children}
        </Paragraph>
      </div>
    </div>
  );
}
