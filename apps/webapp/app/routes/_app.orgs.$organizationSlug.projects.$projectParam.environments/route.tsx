import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ClipboardField } from "~/components/ClipboardField";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header1 } from "~/components/primitives/Headers";
import {
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useProject } from "~/hooks/useProject";
import { EnvironmentsPresenter } from "~/presenters/EnvironmentsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { ProjectParamSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new EnvironmentsPresenter();
    const { environments, clients } = await presenter.call({
      userId,
      slug: projectParam,
    });

    return typedjson({
      environments,
      clients,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText:
        "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const handle: Handle = {
  breadcrumb: {
    slug: "environments",
  },
};

export default function Page() {
  const { environments, clients } = useTypedLoaderData<typeof loader>();

  console.log(environments, clients);

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Environments & API Keys" />
        </PageTitleRow>
        <PageDescription>
          API Keys and endpoints for your environments.
        </PageDescription>
      </PageHeader>
      <PageBody>
        <Header1>API Keys</Header1>
        <div className="flex gap-4">
          {environments.map((environment) => (
            <ClipboardField
              key={environment.id}
              secure
              value={environment.apiKey}
              variant={"primary"}
            />
          ))}
        </div>
      </PageBody>
    </PageContainer>
  );
}
