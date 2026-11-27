import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { UpgradeSessionsDialog } from "~/components/deployments/SkewProtectionThreshold";
import { PermissionButton } from "~/components/primitives/PermissionButton";

/** The "Upgrade sessions" button in an agent's or task's header: opens the dialog for that task. */
export function UpgradeSessionsButton({
  taskIdentifier,
  environmentId,
  canWriteDeployments,
}: {
  taskIdentifier: string;
  environmentId: string;
  canWriteDeployments: boolean;
}) {
  return (
    <UpgradeSessionsDialog environmentId={environmentId} task={taskIdentifier}>
      <PermissionButton
        hasPermission={canWriteDeployments}
        variant="secondary/small"
        LeadingIcon={ShieldCheckIcon}
        leadingIconClassName="text-blue-500"
      >
        Upgrade sessions
      </PermissionButton>
    </UpgradeSessionsDialog>
  );
}
