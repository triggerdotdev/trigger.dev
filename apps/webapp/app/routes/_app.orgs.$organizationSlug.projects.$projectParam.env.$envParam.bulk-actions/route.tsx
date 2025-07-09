import { BookOpenIcon, PlusIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { BulkActionsNone } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3CreateBulkActionPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Bulk actions | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, envParam } = EnvironmentParamSchema.parse(params);

  try {
    return typedjson({
      bulkActions: [],
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { bulkActions } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Bulk actions" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/bulk-actions")}
          >
            Bulk actions docs
          </LinkButton>
          <LinkButton
            variant="primary/small"
            LeadingIcon={PlusIcon}
            to={v3CreateBulkActionPath(organization, project, environment)}
          >
            New bulk action
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        {bulkActions.length === 0 ? (
          <MainCenteredContainer className="max-w-md">
            <BulkActionsNone />
          </MainCenteredContainer>
        ) : (
          <></>
        )}
      </PageBody>
    </PageContainer>
  );
}
