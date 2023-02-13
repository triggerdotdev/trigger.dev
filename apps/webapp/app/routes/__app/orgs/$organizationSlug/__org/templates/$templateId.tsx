import { LoaderArgs } from "@remix-run/server-runtime";
import { useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import { Header1 } from "~/components/primitives/text/Headers";
import { prisma } from "~/db.server";
import { useEventSource } from "remix-utils";
import { useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { OrganizationTemplate } from ".prisma/client";

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

  const events = useEventSource(
    `/resources/organizationTemplates/${organizationTemplate.id}`
  );
  const revalidator = useRevalidator();

  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
  }, [events]);

  return (
    <Container>
      <Header1>{organizationTemplate.template.title}</Header1>
      <br />

      {/* Output a loading spinner until the deploy happens */}
      {organizationTemplate.status === "CREATED" ? (
        <div className="flex justify-center">
          <div className="h-32 w-32 animate-spin rounded-full border-b-2 border-slate-50"></div>
        </div>
      ) : (
        <OrganizationTemplateReadyToDeploy
          organizationTemplate={organizationTemplate}
        />
      )}
    </Container>
  );
}

function OrganizationTemplateReadyToDeploy({
  organizationTemplate,
}: {
  organizationTemplate: OrganizationTemplate;
}) {
  return (
    <div>
      <p>Organization Template ready to deploy</p>

      <dl className="space-y-2">
        <dt className="font-bold">Repo URL</dt>
        <dd>
          <a href={organizationTemplate.repositoryUrl} target="_blank">
            {organizationTemplate.repositoryUrl}
          </a>
        </dd>

        <dt className="font-bold">Is Private</dt>
        <dd>{organizationTemplate.private ? "Yes" : "No"}</dd>
      </dl>
    </div>
  );
}
