import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { requireUser } from "~/services/session.server";
import { concurrencyTracker } from "~/v3/services/taskRunConcurrencyTracker.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const deployedConcurrency = await concurrencyTracker.globalConcurrentRunCount(true);
  const devConcurrency = await concurrencyTracker.globalConcurrentRunCount(false);

  return typedjson({ deployedConcurrency, devConcurrency });
};

export default function AdminDashboardRoute() {
  const { deployedConcurrency, devConcurrency } = useTypedLoaderData<typeof loader>();

  return (
    <main
      aria-labelledby="primary-heading"
      className="flex h-full min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4 lg:order-last"
    >
      <div>
        <Header1 spacing>Dev</Header1>
        <Paragraph spacing>{devConcurrency}</Paragraph>
      </div>
      <div>
        <Header1 spacing>Deployed</Header1>
        <Paragraph spacing>{deployedConcurrency}</Paragraph>
      </div>
    </main>
  );
}
