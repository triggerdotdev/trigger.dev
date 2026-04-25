import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Header1 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Paragraph } from "~/components/primitives/Paragraph";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder.server";
import { concurrencyTracker } from "~/v3/services/taskRunConcurrencyTracker.server";

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async () => {
    const deployedConcurrency = await concurrencyTracker.globalConcurrentRunCount(true);
    const devConcurrency = await concurrencyTracker.globalConcurrentRunCount(false);
    return typedjson({ deployedConcurrency, devConcurrency });
  }
);

export default function AdminDashboardRoute() {
  const { deployedConcurrency, devConcurrency } = useTypedLoaderData<typeof loader>();

  return (
    <main
      aria-labelledby="primary-heading"
      className="flex h-full w-fit min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 lg:order-last"
    >
      <div className="flex items-center divide-x divide-grid-bright rounded border border-grid-bright">
        <div className="w-1/2 p-3">
          <Paragraph spacing>Dev</Paragraph>
          <Header1>{devConcurrency}</Header1>
        </div>
        <div className="w-1/2 p-3">
          <Paragraph spacing>Deployed</Paragraph>
          <Header1>{deployedConcurrency}</Header1>
        </div>
      </div>
      <InfoPanel icon={InformationCircleIcon}>
        This refers to the number of 'Dequeued' runs, which are either currently executing or about
        to begin execution.
      </InfoPanel>
    </main>
  );
}
