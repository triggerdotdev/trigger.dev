import { useTypedMatchesData } from "~/hooks/useTypedMatchData";
import type { loader } from "~/routes/_app.orgs.$organizationSlug/route";

/** Whether the org should see self-serve billing UI (plan picker, Stripe checkout, upgrades). */
export function useShowSelfServe(): boolean {
  const data = useTypedMatchesData<typeof loader>({ id: "routes/_app.orgs.$organizationSlug" });
  return data?.currentPlan?.v3Subscription?.showSelfServe ?? true;
}
