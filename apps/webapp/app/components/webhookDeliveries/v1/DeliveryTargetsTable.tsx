import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { WebhookDeliveryTargetView } from "~/presenters/v3/WebhookDeliveryDetailPresenter.server";
import { v3RunPath, v3SessionPath } from "~/utils/pathBuilder";

const STATUS_STYLE: Record<WebhookDeliveryTargetView["status"], { color: string; label: string }> =
  {
    PENDING: { color: "#878C99", label: "Pending" },
    SUCCEEDED: { color: "#28BF5C", label: "Succeeded" },
    FAILED: { color: "#E11D48", label: "Failed" },
    FILTERED: { color: "#64748B", label: "Filtered" },
  };

function waiterCounts(target: WebhookDeliveryTargetView): string {
  const counts = target.waiters;
  if (!counts) return "";
  const parts = [
    `${counts.resumed.toLocaleString()} of ${counts.matched.toLocaleString()} resumed`,
  ];
  if (counts.failed > 0) parts.push(`${counts.failed.toLocaleString()} gave up`);
  const pending = counts.matched - counts.resumed - counts.failed;
  if (pending > 0) parts.push(`${pending.toLocaleString()} resuming`);
  return parts.join(", ");
}

/** What one delivery did for each subscriber and waiter of its endpoint. */
export function DeliveryTargetsTable({ targets }: { targets: WebhookDeliveryTargetView[] }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <Table showTopBorder={false} stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Target</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Detail</TableHeaderCell>
          <TableHeaderCell>Run</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {targets.length === 0 ? (
          <TableBlankRow colSpan={5}>
            <Paragraph variant="small" className="text-center">
              This delivery had no subscribers or waiters to route to.
            </Paragraph>
          </TableBlankRow>
        ) : (
          targets.map((target) => {
            const status = STATUS_STYLE[target.status];
            return (
              <TableRow key={`${target.type}:${target.id}`}>
                <TableCell>
                  {target.type === "waiter" ? (
                    <span className="text-xs">Waiting runs</span>
                  ) : (
                    <span className="font-mono text-xs">{target.id}</span>
                  )}
                </TableCell>
                <TableCell>{target.kind}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: status.color }}
                    />
                    <span>{status.label}</span>
                  </span>
                </TableCell>
                <TableCell className="max-w-md whitespace-normal">
                  {target.type === "waiter" && target.waiters ? (
                    <span className="flex flex-col gap-0.5">
                      <span>{waiterCounts(target)}</span>
                      {target.error ? (
                        <span className="text-text-bright">{target.error}</span>
                      ) : null}
                    </span>
                  ) : target.error ? (
                    <span className="text-text-bright">{target.error}</span>
                  ) : target.reason ? (
                    <span className="text-text-dimmed">{target.reason}</span>
                  ) : (
                    <span className="text-text-dimmed">None</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    {target.session ? (
                      <TextLink
                        to={v3SessionPath(organization, project, environment, {
                          friendlyId: target.session.friendlyId,
                        })}
                        className="font-mono text-xs"
                      >
                        {target.session.friendlyId}
                      </TextLink>
                    ) : target.run ? (
                      <TextLink
                        to={v3RunPath(organization, project, environment, {
                          friendlyId: target.run.friendlyId,
                        })}
                        className="font-mono text-xs"
                      >
                        {target.run.friendlyId}
                      </TextLink>
                    ) : null}
                    {!target.run && !target.session ? (
                      <span className="text-text-dimmed">None</span>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
