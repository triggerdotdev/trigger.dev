import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { PageContainer, PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageHeader,
  PageTitleRow,
  PageTitle,
  PageButtons,
  PageDescription,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { IntegrationClientPresenter } from "~/presenters/IntegrationClientPresenter.server";
import { IntegrationsPresenter } from "~/presenters/IntegrationsPresenter.server";
import { requireUser } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { docsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, clientParam } = params;
  invariant(organizationSlug, "Organization slug must be defined");
  invariant(clientParam, "Client param must be defined");

  const presenter = new IntegrationClientPresenter();
  const client = await presenter.call({
    userId: user.id,
    organizationSlug,
    clientSlug: clientParam,
  });

  if (!client) {
    throw new Response("Not found", { status: 404 });
  }

  return typedjson({ client });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "integrations",
  },
};

export default function Integrations() {
  const { client } = useTypedLoaderData<typeof loader>();
  // const organization = useOrganization();
  // const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title={client.title} />
        </PageTitleRow>
        <PageDescription>
          Easily use an Integration, an existing Node.js SDK or make HTTP calls
          from a Job.
        </PageDescription>
      </PageHeader>

      <PageBody scrollable={false}>Body</PageBody>
    </PageContainer>
  );
}
