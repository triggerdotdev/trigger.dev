import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  StopIcon,
} from "@heroicons/react/20/solid";
import { FolderIcon } from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";

const icons = {
  warning: (className: string) => (
    <ExclamationTriangleIcon className={cn("text-amber-400", className)} />
  ),
  error: (className: string) => (
    <ExclamationCircleIcon className={cn("text-rose-500", className)} />
  ),
  info: (className: string) => (
    <InformationCircleIcon className={cn("text-blue-500", className)} />
  ),
  folder: (className: string) => (
    <FolderIcon className={cn("text-indigo-600", className)} />
  ),
  plusLarge: (className: string) => (
    <FolderIcon className={cn("text-green-600", className)} />
  ),
  slack: (className: string) => (
    <img src={`/integrations/slack.png`} className={className} alt="Slack" />
  ),
  airtable: (className: string) => (
    <img
      src={`/integrations/airtable.png`}
      className={className}
      alt="Airtable"
    />
  ),
  github: (className: string) => (
    <img src={`/integrations/github.png`} className={className} alt="GitHub" />
  ),
};

export type IconNames = keyof typeof icons;

export function NamedIcon({
  name,
  className,
  fallback,
}: {
  name: string;
  className: string;
  fallback?: JSX.Element;
}) {
  if (Object.keys(icons).includes(name)) {
    return icons[name as IconNames](className);
  }

  if (fallback) {
    return fallback;
  }

  //default fallback icon
  return <StopIcon className={className} />;
}

export function NamedIconInBox({
  name,
  className,
  fallback,
}: {
  name: string;
  className?: string;
  fallback?: JSX.Element;
}) {
  return (
    <div
      className={cn("rounded-sm border-slate-850 bg-slate-900 p-2", className)}
    >
      <NamedIcon name={name} fallback={fallback} className="h-5 w-5" />
    </div>
  );
}
