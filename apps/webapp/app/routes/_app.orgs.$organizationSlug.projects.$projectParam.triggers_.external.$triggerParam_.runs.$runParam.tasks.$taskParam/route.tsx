import { Await, useLoaderData } from "@remix-run/react";
import { LoaderArgs, defer } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { TaskDetail } from "~/components/run/TaskDetail";
import { TaskDetailsPresenter } from "~/presenters/TaskDetailsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { TriggerSourceRunTaskParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { taskParam } = TriggerSourceRunTaskParamsSchema.parse(params);

  const presenter = new TaskDetailsPresenter();
  const taskPromise = presenter.call({
    userId,
    id: taskParam,
  });

  return defer({
    taskPromise,
  });
};

export default function Page() {
  const { taskPromise } = useLoaderData<typeof loader>();

  return (
    <Suspense fallback={<Spinner />}>
      <Await resolve={taskPromise} errorElement={<p>Error loading task!</p>}>
        {(resolvedTask) => resolvedTask && <TaskDetail task={resolvedTask as any} />}
      </Await>
    </Suspense>
  );
}
