import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  StopIcon,
} from "@heroicons/react/20/solid";
import classNames from "classnames";
import { apiStore } from "~/services/externalApis/apiStore";

const iconNames = ["warning", "error", "info"] as const;
export type IconName = (typeof iconNames)[number];

export function NamedIcon({
  name,
  className,
}: {
  name: IconName | string;
  className: string;
}) {
  if (iconNames.includes(name as IconName)) {
    return <PredeterminedIcon name={name as IconName} className={className} />;
  }

  return <IntegrationIcon name={name as string} className={className} />;
}

function PredeterminedIcon({
  name,
  className,
}: {
  name: IconName;
  className: string;
}) {
  switch (name) {
    case "warning":
      return (
        <ExclamationTriangleIcon
          className={classNames(className, "text-yellow-500")}
        />
      );
    case "error":
      return (
        <ExclamationCircleIcon
          className={classNames(className, "text-rose-500")}
        />
      );
    case "info":
      return (
        <InformationCircleIcon
          className={classNames(className, "text-blue-500")}
        />
      );
  }
}

function IntegrationIcon({
  name,
  className,
}: {
  name: string;
  className: string;
}) {
  const api = apiStore.getApi(name);
  if (api) {
    return (
      <img
        src={`/integrations/${name}.png`}
        className={className}
        alt={api.name}
      />
    );
  }

  return <StopIcon className={classNames(className, "text-white/20")} />;
}
