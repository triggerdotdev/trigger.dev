import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { Badge } from "~/components/primitives/Badge";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
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
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { type WebhookEndpointListItem } from "~/presenters/v3/WebhookDetailPresenter.server";
import { v3WebhookEndpointPath } from "~/utils/pathBuilder";
import { EndpointStatusBadge } from "./EndpointStatus";

export function EndpointsTable({
  endpoints,
  stickyHeader = false,
  showTopBorder = true,
}: {
  endpoints: WebhookEndpointListItem[];
  stickyHeader?: boolean;
  showTopBorder?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <Table showTopBorder={showTopBorder} stickyHeader={stickyHeader}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Endpoint</TableHeaderCell>
          <TableHeaderCell>Tenant</TableHeaderCell>
          <TableHeaderCell>External ref</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Secret</TableHeaderCell>
          <TableHeaderCell alignment="right">Deliveries (7d)</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {endpoints.length === 0 ? (
          <TableBlankRow colSpan={7}>
            <div className="flex items-center justify-center">
              <Paragraph className="w-auto">No endpoints for this webhook yet</Paragraph>
            </div>
          </TableBlankRow>
        ) : (
          endpoints.map((endpoint) => {
            const endpointPath = v3WebhookEndpointPath(
              organization,
              project,
              environment,
              endpoint.friendlyId
            );

            return (
              <TableRow key={endpoint.friendlyId}>
                <TableCell to={endpointPath}>
                  <span className="flex items-center gap-x-2">
                    <span className="font-mono text-xs">{endpoint.friendlyId}</span>
                    {endpoint.isDefault ? <Badge variant="extra-small">default</Badge> : null}
                  </span>
                </TableCell>
                <TableCell to={endpointPath}>
                  {endpoint.tenantId ?? <span className="text-text-dimmed">default</span>}
                </TableCell>
                <TableCell to={endpointPath}>
                  {endpoint.externalRef ?? <span className="text-text-dimmed">None</span>}
                </TableCell>
                <TableCell to={endpointPath}>
                  <EndpointStatusBadge status={endpoint.status} />
                </TableCell>
                <TableCell to={endpointPath}>
                  {endpoint.hasSigningSecret ? (
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-success" />
                      <span>Set</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-charcoal-600" />
                      <span className="text-text-dimmed">Not set</span>
                    </span>
                  )}
                </TableCell>
                <TableCell to={endpointPath} alignment="right">
                  {endpoint.deliveryCount.toLocaleString()}
                </TableCell>
                <TableCellMenu
                  isSticky
                  popoverContent={
                    <PopoverMenuItem
                      to={endpointPath}
                      icon={ArrowRightIcon}
                      leadingIconClassName="text-webhooks"
                      title="View endpoint"
                    />
                  }
                />
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
