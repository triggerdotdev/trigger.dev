import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  StopIcon,
} from "@heroicons/react/20/solid";
import {
  CheckIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BuildingOffice2Icon,
  EnvelopeIcon,
  FolderIcon,
  GlobeAltIcon,
  PlusIcon,
  PlusSmallIcon,
} from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";
import { Spinner } from "./Spinner";

const icons = {
  "arrow-right": (className: string) => (
    <ArrowRightIcon className={cn("text-white", className)} />
  ),
  "arrow-left": (className: string) => (
    <ArrowLeftIcon className={cn("text-white", className)} />
  ),
  check: (className: string) => (
    <CheckIcon className={cn("text-dimmed", className)} />
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
  envelope: (className: string) => (
    <EnvelopeIcon className={cn("text-dimmed", className)} />
  ),
  globe: (className: string) => (
    <GlobeAltIcon className={cn("text-fuchsia-500", className)} />
  ),
  organization: (className: string) => (
    <BuildingOffice2Icon className={cn("text-fuchsia-600", className)} />
  ),
  spinner: (className: string) => (
    <Spinner className={className} color="blue" />
  ),
  "spinner-white": (className: string) => (
    <Spinner className={className} color="white" />
  ),
  plus: (className: string) => (
    <PlusIcon className={cn("text-green-600", className)} />
  ),
  "plus-small": (className: string) => (
    <PlusSmallIcon className={cn("text-green-600", className)} />
  ),
  warning: (className: string) => (
    <ExclamationTriangleIcon className={cn("text-amber-400", className)} />
  ),
  //APIs
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
  slack: (className: string) => (
    <img src={`/integrations/slack.png`} className={className} alt="Slack" />
  ),
};

export type IconNames = keyof typeof icons;
export const iconNames = Object.keys(icons) as IconNames[];

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
