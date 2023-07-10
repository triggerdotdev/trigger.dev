import { parse } from "@conform-to/zod";
import { useRevalidator } from "@remix-run/react";
import { ActionFunction, LoaderArgs, json } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { RunOverview } from "~/components/run/RunOverview";
import { runBasicStatus } from "~/components/runs/RunStatuses";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  redirectBackWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { RunPresenter } from "~/presenters/RunPresenter.server";
import { ContinueRunService } from "~/services/runs/continueRun.server";
import { ReRunService } from "~/services/runs/reRun.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  RunParamsSchema,
  jobPath,
  jobRunDashboardPath,
  runPath,
  runStreamingPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { runParam } = RunParamsSchema.parse(params);

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
  });
};

const schema = z.object({});

export const action: ActionFunction = async ({ request, params }) => {
  const { organizationSlug, projectParam, jobParam, runParam } =
    RunParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    if (submission.intent === "start") {
      const rerunService = new ReRunService();
      const run = await rerunService.call({ runId: runParam });

      if (!run) {
        return redirectBackWithErrorMessage(request, "Unable to retry run");
      }

      return redirectWithSuccessMessage(
        jobRunDashboardPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: jobParam },
          { id: run.id }
        ),
        request,
        `Created new run`
      );
    } else if (submission.intent === "continue") {
      const continueService = new ContinueRunService();
      await continueService.call({ runId: runParam });

      return redirectWithSuccessMessage(
        jobRunDashboardPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: jobParam },
          { id: runParam }
        ),
        request,
        `Resuming run`
      );
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export const handle: Handle = {
  breadcrumb: {
    slug: "run",
  },
};

export default function Page() {
  const { run } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

  const revalidator = useRevalidator();
  const events = useEventSource(
    runStreamingPath(organization, project, job, run),
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
      trigger={job.event}
      showRerun={true}
      paths={{
        back: jobPath(organization, project, job),
        run: runPath(organization, project, job, run),
      }}
    />
  );
}
