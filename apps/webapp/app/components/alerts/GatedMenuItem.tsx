import type { ComponentProps } from "react";
import { Button } from "~/components/primitives/Buttons";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { DEFAULT_NO_PERMISSION_TOOLTIP } from "~/components/primitives/PermissionButton";

export function GatedMenuItem({
  allowed,
  deniedTooltip = DEFAULT_NO_PERMISSION_TOOLTIP,
  ...props
}: ComponentProps<typeof PopoverMenuItem> & { allowed: boolean; deniedTooltip?: string }) {
  if (allowed) return <PopoverMenuItem {...props} />;
  return (
    <Button
      type="button"
      variant="small-menu-item"
      LeadingIcon={props.icon}
      leadingIconClassName={props.leadingIconClassName}
      fullWidth
      textAlignLeft
      disabled
      tooltip={deniedTooltip}
    >
      {props.title}
    </Button>
  );
}
