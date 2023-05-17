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
  WrenchScrewdriverIcon,
  SquaresPlusIcon,
  KeyIcon,
  UserGroupIcon,
  CreditCardIcon,
  MagnifyingGlassIcon,
  BookOpenIcon,
  LightBulbIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";
import { Spinner } from "./Spinner";
import { UserProfilePhoto } from "../UserProfilePhoto";

const icons = {
  account: (className: string) => <UserProfilePhoto className={className} />,
  "arrow-right": (className: string) => (
    <ArrowRightIcon className={cn("text-white", className)} />
  ),
  "arrow-left": (className: string) => (
    <ArrowLeftIcon className={cn("text-white", className)} />
  ),
  billing: (className: string) => (
    <CreditCardIcon className={cn("text-teal-500", className)} />
  ),
  check: (className: string) => (
    <CheckIcon className={cn("text-dimmed", className)} />
  ),
  close: (className: string) => (
    <XMarkIcon className={cn("text-dimmed", className)} />
  ),
  docs: (className: string) => (
    <BookOpenIcon className={cn("text-slate-400", className)} />
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
  environment: (className: string) => (
    <KeyIcon className={cn("text-yellow-500", className)} />
  ),
  globe: (className: string) => (
    <GlobeAltIcon className={cn("text-fuchsia-600", className)} />
  ),
  integration: (className: string) => (
    <SquaresPlusIcon className={cn("text-teal-500", className)} />
  ),
  job: (className: string) => (
    <WrenchScrewdriverIcon className={cn("text-teal-500", className)} />
  ),
  lightbulb: (className: string) => (
    <LightBulbIcon className={cn("text-amber-400", className)} />
  ),
  organization: (className: string) => (
    <BuildingOffice2Icon className={cn("text-fuchsia-600", className)} />
  ),
  search: (className: string) => (
    <MagnifyingGlassIcon className={cn("text-dimmed", className)} />
  ),
  plus: (className: string) => (
    <PlusIcon className={cn("text-green-600", className)} />
  ),
  "plus-small": (className: string) => (
    <PlusSmallIcon className={cn("text-green-600", className)} />
  ),
  spinner: (className: string) => (
    <Spinner className={className} color="blue" />
  ),
  "spinner-white": (className: string) => (
    <Spinner className={className} color="white" />
  ),
  team: (className: string) => (
    <UserGroupIcon className={cn("text-blue-500", className)} />
  ),
  warning: (className: string) => (
    <ExclamationTriangleIcon className={cn("text-amber-400", className)} />
  ),
  //APIs
  airtable: (className: string) => (
    <IntegrationIcon slug="airtable" name={"Airtable"} className={className} />
  ),
  github: (className: string) => (
    <IntegrationIcon slug="github" name={"GitHub"} className={className} />
  ),
  slack: (className: string) => (
    <IntegrationIcon slug="slack" name={"Slack"} className={className} />
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

function IntegrationIcon({
  slug,
  name,
  className,
}: {
  slug: string;
  name: string;
  className: string;
}) {
  return (
    <div
      className={cn(
        "grid aspect-square min-h-fit place-items-center",
        className
      )}
    >
      <img
        src={`/integrations/${slug}.png`}
        className="p-[8%]"
        alt={name}
        loading="lazy"
      />
    </div>
  );
}
