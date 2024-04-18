import { BoltSlashIcon, CheckCircleIcon } from "@heroicons/react/20/solid";

export function EnabledStatus({ enabled }: { enabled: boolean }) {
  switch (enabled) {
    case true:
      return (
        <div className="flex items-center gap-1 text-xs text-success">
          <CheckCircleIcon className="h-4 w-4" />
          Enabled
        </div>
      );
    case false:
      return (
        <div className="text-dimmed flex items-center gap-1 text-xs">
          <BoltSlashIcon className="h-4 w-4" />
          Disabled
        </div>
      );
  }
}
