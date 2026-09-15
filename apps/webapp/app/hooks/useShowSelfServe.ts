import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";

/** Whether the org should see self-serve billing UI (plan picker, Stripe checkout, upgrades). */
export function useShowSelfServe(): boolean {
  const plan = useCurrentPlan();
  return plan?.v3Subscription?.showSelfServe ?? true;
}
