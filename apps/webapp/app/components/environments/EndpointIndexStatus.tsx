import { CheckCircleIcon, ClockIcon, XCircleIcon } from "@heroicons/react/20/solid";
import { type EndpointIndexStatus } from "@trigger.dev/database";
import { cn } from "~/utils/cn";
import { Spinner } from "../primitives/Spinner";

export function EndpointIndexStatusIcon({ status }: { status: EndpointIndexStatus }) {
  switch (status) {
    case "PENDING":
      return <ClockIcon className={cn("h-4 w-4", endpointIndexStatusClassNameColor(status))} />;
    case "STARTED":
      return <Spinner className={cn("h-4 w-4", endpointIndexStatusClassNameColor(status))} />;
    case "SUCCESS":
      return (
        <CheckCircleIcon className={cn("h-4 w-4", endpointIndexStatusClassNameColor(status))} />
      );
    case "FAILURE":
      return <XCircleIcon className={cn("h-4 w-4", endpointIndexStatusClassNameColor(status))} />;
  }
}

export function EndpointIndexStatusLabel({ status }: { status: EndpointIndexStatus }) {
  switch (status) {
    case "PENDING":
      return (
        <span className={endpointIndexStatusClassNameColor(status)}>
          {endpointIndexStatusTitle(status)}
        </span>
      );
    case "STARTED":
      return (
        <span className={endpointIndexStatusClassNameColor(status)}>
          {endpointIndexStatusTitle(status)}
        </span>
      );
    case "SUCCESS":
      return (
        <span className={endpointIndexStatusClassNameColor(status)}>
          {endpointIndexStatusTitle(status)}
        </span>
      );
    case "FAILURE":
      return (
        <span className={endpointIndexStatusClassNameColor(status)}>
          {endpointIndexStatusTitle(status)}
        </span>
      );
  }
}

export function endpointIndexStatusTitle(status: EndpointIndexStatus): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "STARTED":
      return "Started";
    case "SUCCESS":
      return "Success";
    case "FAILURE":
      return "Failure";
  }
}

export function endpointIndexStatusClassNameColor(status: EndpointIndexStatus): string {
  switch (status) {
    case "PENDING":
      return "text-text-dimmed";
    case "STARTED":
      return "text-blue-500";
    case "SUCCESS":
      return "text-green-500";
    case "FAILURE":
      return "text-rose-500";
  }
}
