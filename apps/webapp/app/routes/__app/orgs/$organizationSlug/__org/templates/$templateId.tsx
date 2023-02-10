import { LoaderArgs } from "@remix-run/server-runtime";
import { useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import { Header1 } from "~/components/primitives/text/Headers";
import { prisma } from "~/db.server";

export async function loader({ params }: LoaderArgs) {
  const organizationTemplate = await prisma.organizationTemplate.findUnique({
    where: {
      id: params.templateId,
    },
    include: {
      template: true,
    },
  });

  invariant(organizationTemplate, "Template not found");

  return { organizationTemplate };
}

export default function TemplatePage() {
  const { organizationTemplate } = useTypedLoaderData<typeof loader>();

  return (
    <Container>
      <Header1>{organizationTemplate.template.title}</Header1>
      <br />
      <dt className="space-y-2">
        <dt className="font-bold">Repo URL</dt>
        <dd>
          <a href={organizationTemplate.repositoryUrl} target="_blank">
            {organizationTemplate.repositoryUrl}
          </a>
        </dd>

        <dt className="font-bold">Is Private</dt>
        <dd>{organizationTemplate.private ? "Yes" : "No"}</dd>
      </dt>

      <pre>{JSON.stringify(organizationTemplate, null, 2)}</pre>
    </Container>
  );
}
