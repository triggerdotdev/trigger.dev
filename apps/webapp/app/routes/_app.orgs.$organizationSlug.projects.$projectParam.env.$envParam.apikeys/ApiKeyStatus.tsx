import { CheckCircleIcon, ExclamationTriangleIcon, NoSymbolIcon } from "@heroicons/react/20/solid";
import assertNever from "assert-never";
import { cn } from "~/utils/cn";

export type ApiKeyStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export function apiKeyStatus({
  revokedAt,
  expiresAt,
  now,
}: {
  revokedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  now: number;
}): ApiKeyStatus {
  if (revokedAt) return "REVOKED";
  if (expiresAt && new Date(expiresAt).getTime() <= now) return "EXPIRED";
  return "ACTIVE";
}

export function ApiKeyStatusCombo({
  status,
  className,
  iconClassName,
}: {
  status: ApiKeyStatus;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <ApiKeyStatusIcon status={status} className={cn("size-4", iconClassName)} />
      <ApiKeyStatusLabel status={status} />
    </span>
  );
}

function ApiKeyStatusLabel({ status }: { status: ApiKeyStatus }) {
  return (
    // system-mono-label: System themes uncolor the label (see tailwind.css)
    <span className={cn("system-mono-label", apiKeyStatusClassNameColor(status))}>
      {apiKeyStatusTitle(status)}
    </span>
  );
}

function ApiKeyStatusIcon({ status, className }: { status: ApiKeyStatus; className: string }) {
  switch (status) {
    case "ACTIVE":
      return <CheckCircleIcon className={cn(apiKeyStatusClassNameColor(status), className)} />;
    case "EXPIRED":
      return (
        <ExclamationTriangleIcon className={cn(apiKeyStatusClassNameColor(status), className)} />
      );
    case "REVOKED":
      return <NoSymbolIcon className={cn(apiKeyStatusClassNameColor(status), className)} />;
    default: {
      assertNever(status);
    }
  }
}

function apiKeyStatusClassNameColor(status: ApiKeyStatus): string {
  switch (status) {
    case "ACTIVE":
      return "text-success";
    case "EXPIRED":
    case "REVOKED":
      return "text-text-dimmed";
    default: {
      assertNever(status);
    }
  }
}

function apiKeyStatusTitle(status: ApiKeyStatus): string {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "EXPIRED":
      return "Expired";
    case "REVOKED":
      return "Revoked";
    default: {
      assertNever(status);
    }
  }
}
