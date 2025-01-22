import {
  ArrowTopRightOnSquareIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  StopIcon,
} from "@heroicons/react/20/solid";
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  BeakerIcon,
  BellAlertIcon,
  BoltIcon,
  BookOpenIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClipboardDocumentCheckIcon,
  ClockIcon,
  CloudIcon,
  CodeBracketSquareIcon,
  Cog8ToothIcon,
  CreditCardIcon,
  EnvelopeIcon,
  EyeIcon,
  FingerPrintIcon,
  FlagIcon,
  FolderIcon,
  GlobeAltIcon,
  HandRaisedIcon,
  HeartIcon,
  HomeIcon,
  KeyIcon,
  LightBulbIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PlusSmallIcon,
  QrCodeIcon,
  Square2StackIcon,
  SquaresPlusIcon,
  StarIcon,
  TrashIcon,
  UserCircleIcon,
  UserGroupIcon,
  UserIcon,
  UserPlusIcon,
  WindowIcon,
  WrenchScrewdriverIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";
import { CompanyIcon, hasIcon } from "@trigger.dev/companyicons";
import { ActivityIcon, HourglassIcon } from "lucide-react";
import { DynamicTriggerIcon } from "~/assets/icons/DynamicTriggerIcon";
import { EndpointIcon } from "~/assets/icons/EndpointIcon";
import { ErrorIcon } from "~/assets/icons/ErrorIcon";
import { OneTreeIcon } from "~/assets/icons/OneTreeIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { SaplingIcon } from "~/assets/icons/SaplingIcon";
import { ScheduleIcon } from "~/assets/icons/ScheduleIcon";
import { TwoTreesIcon } from "~/assets/icons/TwoTreesIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { cn } from "~/utils/cn";
import { tablerIcons } from "~/utils/tablerIcons";
import { LogoIcon } from "../LogoIcon";
import { Spinner } from "./Spinner";
import tablerSpritePath from "./tabler-sprite.svg";

const icons = {
  account: (className: string) => <UserCircleIcon className={cn("text-charcoal-400", className)} />,
  active: (className: string) => <CheckCircleIcon className={cn("text-green-500", className)} />,
  "arrow-right": (className: string) => <ArrowRightIcon className={cn("text-white", className)} />,
  "arrow-left": (className: string) => <ArrowLeftIcon className={cn("text-white", className)} />,
  background: (className: string) => <CloudIcon className={cn("text-sky-400", className)} />,
  beaker: (className: string) => <BeakerIcon className={cn("text-purple-500", className)} />,
  bell: (className: string) => <BellAlertIcon className={cn("text-amber-500", className)} />,
  billing: (className: string) => <CreditCardIcon className={cn("text-teal-500", className)} />,
  browser: (className: string) => <WindowIcon className={cn("text-text-dimmed", className)} />,
  calendar: (className: string) => (
    <CalendarDaysIcon className={cn("text-purple-500", className)} />
  ),
  check: (className: string) => <CheckIcon className={cn("text-text-dimmed", className)} />,
  "chevron-down": (className: string) => (
    <ChevronDownIcon className={cn("text-text-dimmed", className)} />
  ),
  "chevron-up": (className: string) => (
    <ChevronUpIcon className={cn("text-text-dimmed", className)} />
  ),
  "chevron-left": (className: string) => (
    <ChevronLeftIcon className={cn("text-text-dimmed", className)} />
  ),
  "chevron-right": (className: string) => (
    <ChevronRightIcon className={cn("text-text-dimmed", className)} />
  ),
  countdown: (className: string) => <HourglassIcon className={cn("text-amber-400", className)} />,
  clock: (className: string) => <ClockIcon className={cn("text-cyan-500", className)} />,
  close: (className: string) => <XMarkIcon className={cn("text-text-dimmed", className)} />,
  "connection-alert": (className: string) => (
    <BellAlertIcon className={cn("text-amber-500", className)} />
  ),
  docs: (className: string) => <BookOpenIcon className={cn("text-charcoal-400", className)} />,
  dynamic: (className: string) => <DynamicTriggerIcon className={cn("text-cyan-500", className)} />,
  error: (className: string) => <ErrorIcon className={cn("text-rose-500", className)} />,
  "external-link": (className: string) => (
    <ArrowTopRightOnSquareIcon className={cn("text-text-dimmed", className)} />
  ),
  flag: (className: string) => <FlagIcon className={cn("text-sky-500", className)} />,
  folder: (className: string) => <FolderIcon className={cn("text-indigo-600", className)} />,
  envelope: (className: string) => <EnvelopeIcon className={cn("text-cyan-500", className)} />,
  environment: (className: string) => <KeyIcon className={cn("text-yellow-500", className)} />,
  eye: (className: string) => <EyeIcon className={cn("text-blue-500", className)} />,
  globe: (className: string) => <GlobeAltIcon className={cn("text-fuchsia-600", className)} />,
  "hand-raised": (className: string) => (
    <HandRaisedIcon className={cn("text-amber-400", className)} />
  ),
  heart: (className: string) => <HeartIcon className={cn("text-rose-500", className)} />,
  house: (className: string) => <HomeIcon className={cn("text-text-dimmed", className)} />,
  id: (className: string) => <FingerPrintIcon className={cn("text-rose-200", className)} />,
  inactive: (className: string) => <XCircleIcon className={cn("text-rose-500", className)} />,
  info: (className: string) => <InformationCircleIcon className={cn("text-blue-500", className)} />,
  integration: (className: string) => (
    <SquaresPlusIcon className={cn("text-teal-500", className)} />
  ),
  "invite-member": (className: string) => (
    <UserPlusIcon className={cn("text-indigo-500", className)} />
  ),
  job: (className: string) => (
    <WrenchScrewdriverIcon className={cn("text-indigo-500", className)} />
  ),
  key: (className: string) => <KeyIcon className={cn("text-amber-400", className)} />,
  lightbulb: (className: string) => <LightBulbIcon className={cn("text-amber-400", className)} />,
  "clipboard-checked": (className: string) => (
    <ClipboardDocumentCheckIcon className={cn("text-text-dimmed", className)} />
  ),
  list: (className: string) => <ListBulletIcon className={cn("text-charcoal-400", className)} />,
  log: (className: string) => (
    <ChatBubbleLeftEllipsisIcon className={cn("text-charcoal-400", className)} />
  ),
  "logo-icon": (className: string) => <LogoIcon className={cn(className)} />,
  organization: (className: string) => (
    <BuildingOffice2Icon className={cn("text-fuchsia-600", className)} />
  ),
  plus: (className: string) => <PlusIcon className={cn("text-green-600", className)} />,
  "plus-small": (className: string) => (
    <PlusSmallIcon className={cn("text-green-600", className)} />
  ),
  property: (className: string) => <Cog8ToothIcon className={cn("text-charcoal-600", className)} />,
  pulse: (className: string) => <ActivityIcon className={cn("text-green-600", className)} />,
  "qr-code": (className: string) => <QrCodeIcon className={cn("text-amber-400", className)} />,
  refresh: (className: string) => <ArrowPathIcon className={cn("text-text-bright", className)} />,
  sapling: (className: string) => <SaplingIcon className={cn("text-green-500", className)} />,
  search: (className: string) => (
    <MagnifyingGlassIcon className={cn("text-text-dimmed", className)} />
  ),
  settings: (className: string) => <Cog8ToothIcon className={cn("text-charcoal-600", className)} />,
  spinner: (className: string) => <Spinner className={className} color="blue" />,
  "spinner-white": (className: string) => <Spinner className={className} color="white" />,
  "spinner-dark": (className: string) => <Spinner className={className} color="dark" />,
  squares: (className: string) => (
    <Square2StackIcon className={cn("text-text-dimmed", className)} />
  ),
  star: (className: string) => <StarIcon className={cn("text-yellow-500", className)} />,
  stop: (className: string) => <StopIcon className={cn("text-rose-500", className)} />,
  team: (className: string) => <UserGroupIcon className={cn("text-blue-500", className)} />,
  "trash-can": (className: string) => <TrashIcon className={cn("text-rose-500", className)} />,
  tree: (className: string) => <OneTreeIcon className={cn("text-green-500", className)} />,
  trees: (className: string) => <TwoTreesIcon className={cn("text-green-500", className)} />,
  trigger: (className: string) => <BoltIcon className={cn("text-orange-500", className)} />,
  user: (className: string) => <UserIcon className={cn("text-blue-600", className)} />,
  warning: (className: string) => (
    <ExclamationTriangleIcon className={cn("text-amber-400", className)} />
  ),
  //triggers
  "custom-event": (className: string) => (
    <CodeBracketSquareIcon className={cn("text-toxic-600", className)} />
  ),
  "register-source": (className: string) => (
    <GlobeAltIcon className={cn("text-sky-500", className)} />
  ),
  "schedule-interval": (className: string) => (
    <ClockIcon className={cn("text-sky-500", className)} />
  ),
  "schedule-cron": (className: string) => (
    <ScheduleIcon className={cn("text-sky-500", className)} />
  ),
  "schedule-dynamic": (className: string) => (
    <ScheduleIcon className={cn("text-sky-500", className)} />
  ),
  webhook: (className: string) => <WebhookIcon className={cn("text-pink-500", className)} />,
  endpoint: (className: string) => <EndpointIcon className={cn("text-blue-500", className)} />,
  "http-endpoint": (className: string) => (
    <GlobeAltIcon className={cn("text-blue-500", className)} />
  ),
  runs: (className: string) => <RunsIcon className={cn("text-lime-500", className)} />,
};

export type IconNames = keyof typeof icons;
export type IconNamesOrString = IconNames | (string & {});
export const iconNames = Object.keys(icons) as IconNames[];

export function NamedIcon({
  name,
  className,
  fallback,
}: {
  name: IconNamesOrString;
  className: string;
  fallback?: JSX.Element;
}) {
  if (Object.keys(icons).includes(name)) {
    return icons[name as IconNames](className);
  }

  if (hasIcon(name)) {
    return (
      <span className={cn("grid aspect-square min-h-fit place-items-center", className)}>
        <CompanyIcon
          name={name}
          className={"h-full w-full p-[7%]"}
          variant="light"
          style={{
            shapeRendering: "geometricPrecision",
          }}
        />
      </span>
    );
  }

  if (tablerIcons.has("tabler-" + name)) {
    return <TablerIcon name={"tabler-" + name} className={className} />;
  } else if (name.startsWith("tabler-") && tablerIcons.has(name)) {
    return <TablerIcon name={name} className={className} />;
  }

  if (name === "supabase-management") {
    return <NamedIcon name="supabase" className={className} />;
  }

  if (fallback) {
    return fallback;
  }

  //default fallback icon
  return <StopIcon className={className} />;
}

export function TablerIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={cn("stroke-[1.5]", className)}>
      <use xlinkHref={`${tablerSpritePath}#${name}`} />
    </svg>
  );
}
