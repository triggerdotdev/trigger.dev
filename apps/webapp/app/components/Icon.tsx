import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  StopIcon,
} from "@heroicons/react/20/solid";
import classNames from "classnames";

const icons = {
  warning: (className: string) => (
    <ExclamationTriangleIcon
      className={classNames(className, "text-yellow-500")}
    />
  ),
  error: (className: string) => (
    <ExclamationCircleIcon className={classNames(className, "text-rose-500")} />
  ),
  info: (className: string) => (
    <InformationCircleIcon className={classNames(className, "text-blue-500")} />
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
