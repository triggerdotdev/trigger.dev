import { useRevalidator } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Fragment, useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils/sse/react";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { BreadcrumbIcon } from "~/components/primitives/BreadcrumbIcon";
import { RunOverview } from "~/components/run/RunOverview";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { useUser } from "~/hooks/useUser";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  TriggerSourceRunParamsSchema,
  projectWebhookTriggersPath,
  trimTrailingSlash,
  webhookTriggerPath,
  webhookTriggerRunPath,
  webhookTriggerRunStreamingPath,
  webhookTriggerRunsParentPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { runParam, triggerParam } = TriggerSourceRunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const run = await presenter.call({
    userId,
    id: runParam,
  });

  const trigger = await prisma.webhook.findUnique({
    select: {
      id: true,
      key: true,
      integration: {
        select: {
          id: true,
          title: true,
          slug: true,
          definitionId: true,
          setupStatus: true,
        },
      },
    },
    where: {
      id: triggerParam,
    },
  });

  if (!run || !trigger) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    run,
    trigger,
  });
};

export const handle: Handle = {
  breadcrumb: (match, matches) => {
    const data = useTypedMatchData<typeof loader>(match);
    if (!data) return null;

    const org = useOrganization(matches);
    const project = useProject(matches);

    return (
      <Fragment>
        <BreadcrumbLink to={projectWebhookTriggersPath(org, project)} title="Triggers" />
        <BreadcrumbIcon />
        <BreadcrumbLink to={projectWebhookTriggersPath(org, project)} title="Webhook Triggers" />
        <BreadcrumbIcon />
        <BreadcrumbLink
          to={webhookTriggerPath(org, project, { id: data.trigger.id })}
          title={data.trigger.key}
        />
        <BreadcrumbIcon />
        <BreadcrumbLink
          to={webhookTriggerPath(org, project, { id: data.trigger.id })}
          title="Registrations"
        />
        <BreadcrumbIcon />
        {data && data.run && (
          <BreadcrumbLink
            to={trimTrailingSlash(match.pathname)}
            title={`Run #${data.run.number}`}
          />
        )}
      </Fragment>
    );
  },
};

export default function Page() {
  const { run, trigger } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();

  const revalidator = useRevalidator();
  const events = useEventSource(
    webhookTriggerRunStreamingPath(organization, project, trigger, run),
    {
      event: "message",
    }
  );
  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <RunOverview
      run={run}
      trigger={{ icon: "webhook", title: "Register Webhook" }}
      showRerun={true}
      paths={{
        back: webhookTriggerPath(organization, project, { id: trigger.id }),
        run: webhookTriggerRunPath(organization, project, { id: trigger.id }, run),
        runsPath: webhookTriggerRunsParentPath(organization, project, {
          id: trigger.id,
        }),
      }}
      currentUser={user}
    />
  );
}
