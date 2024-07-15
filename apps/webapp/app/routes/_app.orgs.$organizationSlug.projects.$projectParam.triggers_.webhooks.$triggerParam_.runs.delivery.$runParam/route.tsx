import { useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils/sse/react";
import { RunOverview } from "~/components/run/RunOverview";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  TriggerSourceRunParamsSchema,
  webhookDeliveryPath,
  webhookTriggerDeliveryRunPath,
  webhookTriggerDeliveryRunsParentPath,
  webhookTriggerRunStreamingPath,
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
      trigger={{ icon: "mail-fast", title: "Deliver Webhook" }}
      showRerun={false}
      paths={{
        back: webhookDeliveryPath(organization, project, { id: trigger.id }),
        run: webhookTriggerDeliveryRunPath(organization, project, { id: trigger.id }, run),
        runsPath: webhookTriggerDeliveryRunsParentPath(organization, project, {
          id: trigger.id,
        }),
      }}
      currentUser={user}
    />
  );
}
