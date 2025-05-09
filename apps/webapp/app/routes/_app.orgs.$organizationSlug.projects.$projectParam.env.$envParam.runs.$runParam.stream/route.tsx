import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { RunStreamPresenter } from "~/presenters/v3/RunStreamPresenter.server";
import { requireUserId } from "~/services/session.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireUserId(request);

  const { runParam } = z.object({ runParam: z.string() }).parse(params);

  const presenter = new RunStreamPresenter();
  return presenter.call({ request, runFriendlyId: runParam });
}
