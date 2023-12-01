import { CheckBadgeIcon } from "@heroicons/react/24/solid";
import { RunsVolumeDiscountTable } from "~/components/billing/RunsVolumeDiscountTable";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useNewCustomerSubscribed } from "~/hooks/useNewCustomerSubscribed";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  scripts: () => [
    {
      src: "https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js",
      crossOrigin: "anonymous",
    },
  ],
};

export default function Subscribed() {
  const currentPlan = useCurrentPlan();
  useNewCustomerSubscribed();
  return (
    <MainCenteredContainer className="max-w-[22rem]">
      <FormTitle
        LeadingIcon={<CheckBadgeIcon className="h-7 w-7 text-green-600" />}
        title="You're subscribed!"
        className="mb-0"
      />
      <ul>
        <PlanItem item="Your plan" value="Pro" />
        <PlanItem item="Concurrent Runs/mo" value="Up to 20" />
        <PlanItem item="Runs/mo" value="Volume discounted" />
      </ul>

      <RunsVolumeDiscountTable hideHeader className="mb-4 border-b border-border pb-2 pl-4" />
      <FormButtons
        confirmButton={
          <LinkButton to={"/"} variant={"primary/small"} TrailingIcon={"arrow-right"}>
            Finish
          </LinkButton>
        }
      />
    </MainCenteredContainer>
  );
}

function PlanItem({ item, value }: { item: string; value: string }) {
  return (
    <li className="flex items-center justify-between border-b border-border py-2">
      <Paragraph>{item}</Paragraph>
      <Paragraph variant="base/bright" className="font-medium">
        {value}
      </Paragraph>
    </li>
  );
}
