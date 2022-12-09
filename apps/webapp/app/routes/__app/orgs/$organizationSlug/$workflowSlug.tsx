import { Link, Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { getWorkflowFromSlugs } from "~/models/workflow.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");
  invariant(workflowSlug, "workflowSlug not found");

  const workflow = await getWorkflowFromSlugs({
    userId,
    organizationSlug,
    workflowSlug,
  });

  if (workflow === null) {
    throw new Response("Not Found", { status: 404 });
  }

  return typedjson({ workflow });
};

export default function Organization() {
  const { workflow } = useTypedLoaderData<typeof loader>();

  return (
    <div className="grid grid-cols-[1fr_3fr] h-full">
      <div className=" border-r border-slate-300 p-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl">{workflow.title}</h1>
          <Link to="overview">Overview</Link>
          <Link to="runs">Runs</Link>
          <Link to="settings">Settings</Link>
        </div>
      </div>
      <div className="p-6">
        <Outlet />
      </div>
    </div>
  );
}
