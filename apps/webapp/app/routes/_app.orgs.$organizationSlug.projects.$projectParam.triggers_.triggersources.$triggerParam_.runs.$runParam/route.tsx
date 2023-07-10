import { useRevalidator } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { RunOverview } from "~/components/run/RunOverview";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  TriggerSourceRunParamsSchema,
  triggerSourcePath,
  triggerSourceRunPath,
  triggerSourceRunStreamingPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { runParam, triggerParam } = TriggerSourceRunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const run = await presenter.call({
    userId,
    id: runParam,
  });

  if (!run) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    run,
    triggerParam,
  });
};

export default function Page() {
  const { run, triggerParam } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  const revalidator = useRevalidator();
  const events = useEventSource(
    triggerSourceRunStreamingPath(
      organization,
      project,
      { id: triggerParam },
      run
    ),
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
      trigger={{ icon: "register-source", title: "Register external source" }}
      showRerun={false}
      paths={{
        back: triggerSourcePath(organization, project, { id: triggerParam }),
        run: triggerSourceRunPath(
          organization,
          project,
          { id: triggerParam },
          run
        ),
      }}
    />
  );
}
