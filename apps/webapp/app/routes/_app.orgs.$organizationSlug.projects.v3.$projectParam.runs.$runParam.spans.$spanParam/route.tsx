import { Await, useLoaderData, useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs, defer, json } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Callout } from "~/components/primitives/Callout";
import { Header1 } from "~/components/primitives/Headers";
import { Spinner } from "~/components/primitives/Spinner";
import { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";
import { requireUserId } from "~/services/session.server";
import { useMatchesData } from "~/utils";
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
            <Header1 spacing>{event.message}</Header1>
          </div>
        )}
      </Await>
    </Suspense>
  );
}
