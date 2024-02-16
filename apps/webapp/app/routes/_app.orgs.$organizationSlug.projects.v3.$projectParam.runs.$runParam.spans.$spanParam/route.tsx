import { Await, useLoaderData } from "@remix-run/react";
import { LoaderFunctionArgs, defer } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Spinner } from "~/components/primitives/Spinner";
import { eventTextClassName } from "~/components/runs/v3/EventText";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3SpanParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, spanParam } = v3SpanParamsSchema.parse(params);

  const presenter = new SpanPresenter();
  const span = presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    spanId: spanParam,
  });

  return defer({ span });
};

export default function Page() {
  const { span } = useLoaderData<typeof loader>();

  return (
    <Suspense
      fallback={
        <div className="h-full w-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <Await
        resolve={span}
        errorElement={
          <div>
            <Callout variant="error">There's been an error</Callout>
          </div>
        }
      >
        {({ event }) => (
          <div>
            <div className="border-b border-slate-800">
              <div className="flex h-8 items-center justify-between gap-2 border-b border-ui-border px-2">
                <div className="flex items-center gap-1 overflow-x-hidden">
                  <RunIcon name={event.style?.icon} className="min-w-4 min-h-4 h-4 w-4" />
                  <Header2 className={cn("whitespace-nowrap", eventTextClassName(event))}>
                    {event.message}
                  </Header2>
                </div>
                <ShortcutKey shortcut={{ key: "esc" }} variant="small" />
              </div>
            </div>
            <div></div>
          </div>
        )}
      </Await>
    </Suspense>
  );
}
