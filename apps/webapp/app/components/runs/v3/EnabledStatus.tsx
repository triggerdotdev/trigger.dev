import { BoltSlashIcon, CheckCircleIcon } from "@heroicons/react/20/solid";

type EnabledStatusProps = {
  enabled: boolean;
  enabledIcon?: React.ComponentType<any>;
  disabledIcon?: React.ComponentType<any>;
};

export function EnabledStatus({
  enabled,
  enabledIcon = CheckCircleIcon,
  disabledIcon = BoltSlashIcon,
}: EnabledStatusProps) {
  const EnabledIcon = enabledIcon;
  const DisabledIcon = disabledIcon;

  switch (enabled) {
    case true:
      return (
        <div className="flex items-center gap-1 text-xs text-success">
          <EnabledIcon className="size-4" />
          Enabled
        </div>
      );
    case false:
      return (
        <div className="text-dimmed flex items-center gap-1 text-xs">
          <DisabledIcon className="size-4" />
          Disabled
        </div>
      );
  }
}
