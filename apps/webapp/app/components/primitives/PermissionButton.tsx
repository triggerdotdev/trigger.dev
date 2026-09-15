import { forwardRef, type ReactNode } from "react";
import { Button } from "./Buttons";

export const DEFAULT_NO_PERMISSION_TOOLTIP = "You don't have permission to do this";

type PermissionButtonProps = React.ComponentProps<typeof Button> & {
  /** Server-computed flag (see `checkPermissions`). When false the button is disabled with a tooltip. */
  hasPermission: boolean;
  noPermissionTooltip?: ReactNode;
};

/**
 * A `Button` that disables itself and shows an explanatory tooltip when the
 * user lacks permission. Display only — the server route builder's
 * `authorization` block is the real gate. `Button` already renders its
 * `tooltip` while disabled (it wraps the disabled button in a hoverable span),
 * so we reuse that path.
 */
export const PermissionButton = forwardRef<HTMLButtonElement, PermissionButtonProps>(
  ({ hasPermission, noPermissionTooltip, disabled, tooltip, ...props }, ref) => {
    if (hasPermission) {
      return <Button ref={ref} disabled={disabled} tooltip={tooltip} {...props} />;
    }

    return (
      <Button
        ref={ref}
        {...props}
        disabled
        tooltip={noPermissionTooltip ?? DEFAULT_NO_PERMISSION_TOOLTIP}
      />
    );
  }
);

PermissionButton.displayName = "PermissionButton";
