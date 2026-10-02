import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { useLocation, useNavigation } from "@remix-run/react";
import { Badge } from "~/components/primitives/Badge";
import { DateTime } from "~/components/primitives/DateTime";
import { MiddleTruncate } from "~/components/primitives/MiddleTruncate";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { Spinner } from "~/components/primitives/Spinner";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
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
import { type EndpointDeliveryListItem } from "~/presenters/v3/WebhookDetailPresenter.server";
import { v3WebhookDeliveryPath } from "~/utils/pathBuilder";
import { cn } from "~/utils/cn";
import { DeliveryStatusBadge } from "./DeliveryStatus";

export function DeliveriesTable({
  deliveries,
  hasFilters,
  showTopBorder = true,
  stickyHeader = false,
}: {
  deliveries: EndpointDeliveryListItem[];
  hasFilters?: boolean;
  showTopBorder?: boolean;
  stickyHeader?: boolean;
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
          <TableHeaderCell>Delivery</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>External delivery ID</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Error</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deliveries.length === 0 ? (
          <TableBlankRow colSpan={6}>
            <div className="flex items-center justify-center">
              <Paragraph className="w-auto">
                {hasFilters ? "No deliveries match these filters" : "No deliveries yet"}
              </Paragraph>
            </div>
          </TableBlankRow>
        ) : (
          deliveries.map((delivery) => {
            const deliveryPath = v3WebhookDeliveryPath(
              organization,
              project,
              environment,
              delivery.friendlyId
            );

            return (
              <TableRow key={delivery.id}>
                <TableCell to={deliveryPath}>
                  <span className="flex items-center gap-1.5">
                    <TruncatedCopyableValue value={delivery.friendlyId} className="text-xs" />
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
                <TableCell to={deliveryPath}>
                  <DateTime date={delivery.createdAt} />
                </TableCell>
                <TableCell to={deliveryPath}>
                  {delivery.status === "FAILED" && delivery.errorMessage ? (
                    <SimpleTooltip
                      content={delivery.errorMessage}
                      button={
                        <span className="block max-w-[32ch] truncate text-xs text-text-bright">
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
                <DeliveryActionsCell deliveryPath={deliveryPath} />
              </TableRow>
            );
          })
        )}
        {isLoading && (
          <TableBlankRow
            colSpan={6}
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

function DeliveryActionsCell({ deliveryPath }: { deliveryPath: string }) {
  return (
    <TableCellMenu
      isSticky
      popoverContent={
        <PopoverMenuItem
          to={deliveryPath}
          icon={ArrowRightIcon}
          leadingIconClassName="text-webhooks"
          title="View delivery"
        />
      }
    />
  );
}
