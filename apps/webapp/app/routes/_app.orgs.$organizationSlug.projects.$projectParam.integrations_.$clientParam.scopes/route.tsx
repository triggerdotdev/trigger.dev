import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Paragraph } from "~/components/primitives/Paragraph";
import { IntegrationClientScopesPresenter } from "~/presenters/IntegrationClientScopesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { IntegrationClientParamSchema } from "~/utils/pathBuilder";

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

export const handle: Handle = {
  breadcrumb: {
    slug: "integration-scopes",
  },
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
