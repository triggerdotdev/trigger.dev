import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { useLocation, useNavigation } from "@remix-run/react";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { Badge } from "~/components/primitives/Badge";
import { DateTime } from "~/components/primitives/DateTime";
import { MiddleTruncate } from "~/components/primitives/MiddleTruncate";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { type WebhookDeliveryListItem } from "~/presenters/v3/WebhookDetailPresenter.server";
import {
  v3RunPath,
  v3SessionPath,
  v3WebhookDeliveryPath,
  v3WebhookTaskPath,
} from "~/utils/pathBuilder";
import { cn } from "~/utils/cn";
import { DeliveryStatusBadge } from "./DeliveryStatus";

export function DeliveriesTable({
  deliveries,
  hasFilters,
  showTopBorder = true,
  stickyHeader = false,
  showWebhook = false,
}: {
  deliveries: WebhookDeliveryListItem[];
  hasFilters?: boolean;
  showTopBorder?: boolean;
  stickyHeader?: boolean;
  // The top-level (cross-endpoint) deliveries page shows which webhook each delivery
  // belongs to; the per-webhook detail page leaves this off.
  showWebhook?: boolean;
}) {
  const navigation = useNavigation();
  const location = useLocation();
  const isLoading =
    navigation.state !== "idle" && navigation.location?.pathname === location.pathname;

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <Table
      className="max-h-full overflow-y-auto"
      showTopBorder={showTopBorder}
      stickyHeader={stickyHeader}
    >
      <TableHeader>
        <TableRow>
          {showWebhook && <TableHeaderCell>Webhook</TableHeaderCell>}
          <TableHeaderCell>Delivery</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>External delivery ID</TableHeaderCell>
          <TableHeaderCell>Target</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Processed</TableHeaderCell>
          <TableHeaderCell>Error</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deliveries.length === 0 ? (
          <TableBlankRow colSpan={showWebhook ? 9 : 8}>
            <div className="flex items-center justify-center">
              <Paragraph className="w-auto">
                {hasFilters
                  ? "No deliveries match these filters"
                  : "No deliveries for this webhook yet"}
              </Paragraph>
            </div>
          </TableBlankRow>
        ) : (
          deliveries.map((delivery) => {
            const runPath = delivery.run
              ? v3RunPath(organization, project, environment, {
                  friendlyId: delivery.run.friendlyId,
                })
              : undefined;

            // Session deliveries route to a session (their run is just its current turn), so the
            // session is the meaningful target; task deliveries fall back to the run.
            const sessionPath = delivery.session
              ? v3SessionPath(organization, project, environment, {
                  friendlyId: delivery.session.friendlyId,
                })
              : undefined;

            const webhookPath = delivery.webhook
              ? v3WebhookTaskPath(organization, project, environment, delivery.webhook.slug)
              : undefined;

            const deliveryPath = v3WebhookDeliveryPath(
              organization,
              project,
              environment,
              delivery.friendlyId
            );

            return (
              <TableRow key={delivery.id}>
                {showWebhook && (
                  <TableCell to={webhookPath}>
                    {delivery.webhook ? (
                      <span className="flex items-center gap-x-1">
                        <WebhookIcon className="size-4.5 min-w-4.5 text-webhooks" />
                        {delivery.webhook.slug}
                      </span>
                    ) : (
                      <span className="text-text-dimmed group-hover/table-row:text-text-bright">
                        Unknown
                      </span>
                    )}
                  </TableCell>
                )}
                <TableCell to={deliveryPath}>
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-xs">{delivery.friendlyId}</span>
                    {delivery.isTest ? <Badge variant="extra-small">Test</Badge> : null}
                  </span>
                </TableCell>
                <TableCell to={deliveryPath}>
                  <DeliveryStatusBadge status={delivery.status} />
                </TableCell>
                <TableCell to={deliveryPath}>
                  {delivery.externalDeliveryId ? (
                    <div className="w-[24ch]">
                      <MiddleTruncate
                        text={delivery.externalDeliveryId}
                        className="font-mono text-xs"
                      />
                    </div>
                  ) : (
                    <span className="text-text-dimmed group-hover/table-row:text-text-bright">
                      None
                    </span>
                  )}
                </TableCell>
                {/* Falls back to the delivery so the whole row stays clickable when there is no target */}
                <TableCell to={sessionPath ?? runPath ?? deliveryPath}>
                  {delivery.session ? (
                    <span className="flex items-center gap-x-1">
                      <AIChatIcon className="size-4 text-sessions" />
                      <span className="font-mono text-xs">{delivery.session.friendlyId}</span>
                    </span>
                  ) : delivery.run ? (
                    <span className="flex items-center gap-x-1">
                      <RunsIcon className="size-4 text-runs" />
                      <span className="font-mono text-xs">{delivery.run.friendlyId}</span>
                    </span>
                  ) : (
                    <span className="text-text-dimmed group-hover/table-row:text-text-bright">
                      None
                    </span>
                  )}
                </TableCell>
                <TableCell to={deliveryPath}>
                  <DateTime date={delivery.createdAt} />
                </TableCell>
                <TableCell to={deliveryPath}>
                  {delivery.processedAt ? (
                    <DateTime date={delivery.processedAt} />
                  ) : (
                    <span className="text-text-dimmed group-hover/table-row:text-text-bright">
                      None
                    </span>
                  )}
                </TableCell>
                <TableCell to={deliveryPath}>
                  {delivery.status === "FAILED" && delivery.errorMessage ? (
                    <SimpleTooltip
                      content={delivery.errorMessage}
                      button={
                        <span className="block max-w-[32ch] truncate text-xs text-error">
                          {delivery.errorMessage}
                        </span>
                      }
                    />
                  ) : (
                    <span className="text-text-dimmed group-hover/table-row:text-text-bright">
                      None
                    </span>
                  )}
                </TableCell>
                <DeliveryActionsCell
                  deliveryPath={deliveryPath}
                  runPath={runPath}
                  sessionPath={sessionPath}
                />
              </TableRow>
            );
          })
        )}
        {isLoading && (
          <TableBlankRow
            colSpan={showWebhook ? 9 : 8}
            className={cn(
              "absolute left-0 top-0 flex h-full w-full items-center justify-center gap-2 bg-charcoal-900/90"
            )}
          >
            <Spinner /> <span className="text-text-dimmed">Loading…</span>
          </TableBlankRow>
        )}
      </TableBody>
    </Table>
  );
}

function DeliveryActionsCell({
  deliveryPath,
  runPath,
  sessionPath,
}: {
  deliveryPath: string;
  runPath?: string;
  sessionPath?: string;
}) {
  return (
    <TableCellMenu
      isSticky
      popoverContent={
        <>
          <PopoverMenuItem
            to={deliveryPath}
            icon={ArrowRightIcon}
            leadingIconClassName="text-webhooks"
            title="View delivery"
          />
          {sessionPath ? (
            <PopoverMenuItem
              to={sessionPath}
              icon={ArrowRightIcon}
              leadingIconClassName="text-runs"
              title="View session"
            />
          ) : null}
          {runPath ? (
            <PopoverMenuItem
              to={runPath}
              icon={ArrowRightIcon}
              leadingIconClassName="text-runs"
              title="View run"
            />
          ) : null}
        </>
      }
    />
  );
}
