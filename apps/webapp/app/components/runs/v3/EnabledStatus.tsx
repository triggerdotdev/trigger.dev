import { BellAlertIcon, BellSlashIcon } from "@heroicons/react/20/solid";

export function EnabledStatus({ enabled }: { enabled: boolean }) {
  switch (enabled) {
    case true:
      return (
        <div className="flex items-center gap-1 text-xs text-success">
          <BellAlertIcon className="size-4" />
          Enabled
        </div>
      );
    case false:
      return (
        <div className="text-dimmed flex items-center gap-1 text-xs">
          <BellSlashIcon className="size-4" />
          Disabled
        </div>
      );
  }
}
