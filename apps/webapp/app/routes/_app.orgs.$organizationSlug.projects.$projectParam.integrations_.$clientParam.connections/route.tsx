import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { connectionType } from "~/components/integrations/connectionType";
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
import { useIntegrationClient } from "~/hooks/useIntegrationClient";
import { useProject } from "~/hooks/useProject";
import { IntegrationClientConnectionsPresenter } from "~/presenters/IntegrationClientConnectionsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { IntegrationClientParamSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, clientParam } =
    IntegrationClientParamSchema.parse(params);

  const presenter = new IntegrationClientConnectionsPresenter();
  const { connections } = await presenter.call({
    userId: userId,
    organizationSlug,
    projectSlug: projectParam,
    clientSlug: clientParam,
  });

  return typedjson({ connections });
};

export default function Page() {
  const { connections } = useTypedLoaderData<typeof loader>();
  const client = useIntegrationClient();
  const project = useProject();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Run count</TableHeaderCell>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Expires</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Updated</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {connections.length > 0 ? (
          connections.map((connection) => {
            return (
              <TableRow key={connection.id}>
                <TableCell>{connection.id}</TableCell>
                <TableCell>{connectionType(connection.type)}</TableCell>
                <TableCell>{connection.runCount}</TableCell>
                <TableCell>{connection.metadata?.account ?? "–"}</TableCell>
                <TableCell>
                  <ExpiresAt expiresAt={connection.expiresAt} />
                </TableCell>
                <TableCell>{formatDateTime(connection.createdAt)}</TableCell>
                <TableCell>{formatDateTime(connection.updatedAt)}</TableCell>
              </TableRow>
            );
          })
        ) : (
          <TableBlankRow colSpan={7}>
            <Paragraph
              variant="small"
              className="flex items-center justify-center"
            >
              No connections
            </Paragraph>
          </TableBlankRow>
        )}
      </TableBody>
    </Table>
  );
}

function ExpiresAt({ expiresAt }: { expiresAt: Date | null }) {
  if (!expiresAt) return <>–</>;

  const inPast = expiresAt < new Date();

  return (
    <span className={inPast ? "text-rose-500" : ""}>
      {formatDateTime(expiresAt)}
    </span>
  );
}
