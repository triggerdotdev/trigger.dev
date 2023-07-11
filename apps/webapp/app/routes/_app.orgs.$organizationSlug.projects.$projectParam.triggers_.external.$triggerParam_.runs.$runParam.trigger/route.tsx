import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TriggerDetail } from "~/components/run/TriggerDetail";
import { TriggerDetailsPresenter } from "~/presenters/TriggerDetailsPresenter.server";
import { TriggerSourceRunParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const { runParam } = TriggerSourceRunParamsSchema.parse(params);

  const presenter = new TriggerDetailsPresenter();
  const trigger = await presenter.call(runParam);

  if (!trigger) {
    throw new Response(null, {
      status: 404,
    });
  }

  return typedjson({
    trigger,
  });
};

export default function Page() {
  const { trigger } = useTypedLoaderData<typeof loader>();

  return (
    <TriggerDetail
      trigger={trigger}
      event={{ icon: "register-source", title: "Register external source" }}
      properties={[]}
    />
  );
}
