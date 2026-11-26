import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { actionButtonProps } from "./ApiKeyActions";

/** Set when the org has the audit log; `canView` when the role can read it. */
export type ApiKeysAuditLog = { canView: boolean } | null;

const NO_PERMISSION = "You don't have permission to view the audit log";

/** The page's "View history": the audit log's credential events for this environment. */
export function ViewApiKeysHistoryButton({
  auditLog,
  to,
}: {
  auditLog: ApiKeysAuditLog;
  to: string;
}) {
  if (!auditLog) return null;
  return auditLog.canView ? (
    <LinkButton to={to} variant="secondary/small">
      View history
    </LinkButton>
  ) : (
    <Button variant="secondary/small" disabled tooltip={NO_PERMISSION}>
      View history
    </Button>
  );
}

/** A key's "View activity" menu item: the audit log filtered to that key. */
export function ViewApiKeyActivityMenuItem({
  auditLog,
  to,
}: {
  auditLog: ApiKeysAuditLog;
  to: string;
}) {
  if (!auditLog) return null;
  return auditLog.canView ? (
    <LinkButton to={to} {...actionButtonProps("menu")} LeadingIcon={ListCheckedIcon}>
      View activity
    </LinkButton>
  ) : (
    <Button
      {...actionButtonProps("menu")}
      LeadingIcon={ListCheckedIcon}
      disabled
      tooltip={NO_PERMISSION}
    >
      View activity
    </Button>
  );
}
