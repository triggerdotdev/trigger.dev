import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TaskDetail } from "~/components/run/TaskDetail";
import { TaskDetailsPresenter } from "~/presenters/TaskDetailsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { TaskParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { taskParam } = TaskParamsSchema.parse(params);

  const presenter = new TaskDetailsPresenter();
  const task = await presenter.call({
    userId,
    id: taskParam,
  });

  if (!task) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    task,
  });
};

export default function Page() {
  const { task } = useTypedLoaderData<typeof loader>();
  return <TaskDetail task={task} />;
}
