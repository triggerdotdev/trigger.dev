import { type ReactNode } from "react";
import { cn } from "~/utils/cn";
import { ButtonContent, type ButtonContentPropsType, LinkButton } from "./Buttons";
import { SimpleTooltip } from "./Tooltip";
import { DEFAULT_NO_PERMISSION_TOOLTIP } from "./PermissionButton";

type PermissionLinkProps = React.ComponentProps<typeof LinkButton> & {
  /** Server-computed flag (see `checkPermissions`). When false the link is disabled with a tooltip. */
  hasPermission: boolean;
  noPermissionTooltip?: ReactNode;
};

/**
 * A `LinkButton` that disables itself and shows an explanatory tooltip when the
 * user lacks permission. Display only — the server route builder's
 * `authorization` block is the real gate. Unlike `Button`, `LinkButton` has no
 * tooltip support and renders a `pointer-events-none` element when disabled
 * (which can't be hovered), so the denied state renders a `SimpleTooltip`
 * around a non-interactive `ButtonContent` instead — the same pattern the team
 * settings page uses for its gated controls.
 */
export function PermissionLink({
  hasPermission,
  noPermissionTooltip,
  ...props
}: PermissionLinkProps) {
  if (hasPermission) {
    return <LinkButton {...props} />;
  }

  return (
    <SimpleTooltip
      button={
        <ButtonContent
          {...(props as ButtonContentPropsType)}
          className={cn(props.className, "cursor-not-allowed opacity-50")}
        />
      }
      content={noPermissionTooltip ?? DEFAULT_NO_PERMISSION_TOOLTIP}
      disableHoverableContent
    />
  );
}
