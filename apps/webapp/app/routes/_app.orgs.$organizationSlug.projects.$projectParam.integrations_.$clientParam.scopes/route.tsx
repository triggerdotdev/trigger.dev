import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { connectionType } from "~/components/integrations/connectionType";
import { DateTime } from "~/components/primitives/DateTime";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { runStatusTitle } from "~/components/runs/RunStatuses";
import { useIntegrationClient } from "~/hooks/useIntegrationClient";
import { useProject } from "~/hooks/useProject";
import { IntegrationClientConnectionsPresenter } from "~/presenters/IntegrationClientConnectionsPresenter.server";
import { IntegrationClientScopesPresenter } from "~/presenters/IntegrationClientScopesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { IntegrationClientParamSchema, jobPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, clientParam } =
    IntegrationClientParamSchema.parse(params);

  const presenter = new IntegrationClientScopesPresenter();
  const { scopes } = await presenter.call({
    userId: userId,
    organizationSlug,
    projectSlug: projectParam,
    clientSlug: clientParam,
  });

  return typedjson({ scopes });
};

export default function Page() {
  const { scopes } = useTypedLoaderData<typeof loader>();

  return (
    <ul className="flex max-w-md flex-col gap-4 divide-y divide-slate-800">
      {scopes.map((scope) => (
        <li key={scope.name} className="flex flex-col gap-1 pt-4 first:pt-0">
          <Paragraph className="font-mono text-bright">{scope.name}</Paragraph>
          <Paragraph variant="small">{scope.description}</Paragraph>
        </li>
      ))}
    </ul>
  );
}
