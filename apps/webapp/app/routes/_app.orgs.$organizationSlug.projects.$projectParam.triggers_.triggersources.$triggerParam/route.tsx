import { Response } from "@remix-run/node";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { DynamicTriggerSourcePresenter } from "~/presenters/DynamicTriggerSourcePresenter.server";
import { requireUser } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  TriggerSourceParamSchema,
  projectTriggersPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, triggerParam } =
    TriggerSourceParamSchema.parse(params);

  const presenter = new DynamicTriggerSourcePresenter();
  const { trigger } = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
    triggerSourceId: triggerParam,
  });

  if (!trigger) {
    throw new Response("Trigger not found", {
      status: 404,
      statusText: "Not Found",
    });
  }

  return typedjson({ trigger });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "trigger",
  },
};

//todo outlet somewhere, look at how I did this with the integration client page.

export default function Integrations() {
  const { trigger } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle
            title="Trigger detail"
            backButton={{
              to: projectTriggersPath(organization, project),
              text: "Triggers",
            }}
          />
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={trigger.integration.definitionId}
              label="Integration"
              value={trigger.integration.title}
            />
          </PageInfoGroup>
        </PageInfoRow>
      </PageHeader>

      <PageBody scrollable={false}>
        {/* <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <div>
            <Header2 spacing>External Triggers</Header2>
            <Paragraph variant="small" spacing>
              Webhooks are connected as external Triggers
            </Paragraph>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Integration</TableHeaderCell>
                  <TableHeaderCell>Properties</TableHeaderCell>
                  <TableHeaderCell>Active</TableHeaderCell>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {triggers.map((t) => {
                  const path = triggerSourcePath(organization, project, t);
                  return (
                    <TableRow key={t.id}>
                      <TableCell to={path}>
                        <span className="flex items-center gap-1">
                          <NamedIcon
                            name={t.integration.definitionId}
                            className="h-6 w-6"
                          />
                          {t.integration.title}
                        </span>
                      </TableCell>
                      <TableCell to={path}>
                        {t.params && (
                          <SimpleTooltip
                            button={
                              <div className="flex max-w-[200px] items-start justify-start gap-5 truncate">
                                {Object.entries(t.params).map(
                                  ([label, value], index) => (
                                    <LabelValueStack
                                      key={index}
                                      label={label}
                                      value={value}
                                      className="last:truncate"
                                    />
                                  )
                                )}
                              </div>
                            }
                            content={
                              <div className="flex flex-col gap-2">
                                {Object.entries(t.params).map(
                                  ([label, value], index) => (
                                    <LabelValueStack
                                      key={index}
                                      label={label}
                                      value={value}
                                    />
                                  )
                                )}
                              </div>
                            }
                          />
                        )}
                      </TableCell>
                      <TableCell to={path}>
                        {t.active ? (
                          <CheckCircleIcon className="h-6 w-6 text-green-500" />
                        ) : (
                          <XCircleIcon className="h-6 w-6 text-rose-500" />
                        )}
                      </TableCell>
                      <TableCell to={path}>
                        <span className="flex">
                          <EnvironmentLabel environment={t.environment} />
                        </span>
                      </TableCell>
                      <TableCellChevron to={path} />
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div> */}
      </PageBody>
    </PageContainer>
  );
}
