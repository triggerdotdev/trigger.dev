import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageButtons,
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { getJob } from "~/models/job.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { testJobPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam } = params;
  invariant(jobParam, "jobParam not found");

  const job = await getJob({
    userId,
    id: jobParam,
  });

  if (job === null) {
    throw new Response("Not Found", { status: 404 });
  }

  //todo identify job
  // analytics.job.identify({ job });

  return typedjson({
    job,
  });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "job",
  },
};

export default function Job() {
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title={job.title} />
          <PageButtons>
            <LinkButton
              to={testJobPath(organization, project, job)}
              variant="primary/small"
              shortcut="T"
            >
              Run Test
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={job.event.icon}
              label={"Trigger"}
              text={job.event.title}
            />
            {job.event.elements &&
              job.event.elements.map((element, index) => (
                <PageInfoProperty
                  key={index}
                  icon="property"
                  label={element.label}
                  text={element.text}
                />
              ))}
          </PageInfoGroup>
          <PageInfoGroup alignment="right">
            <Paragraph variant="extra-small" className="text-slate-600">
              UID: {job.id}
            </Paragraph>
          </PageInfoGroup>
        </PageInfoRow>
      </PageHeader>
      <PageBody>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}
