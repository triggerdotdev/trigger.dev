import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import type { Meta, StoryObj } from "@storybook/react";
import { LinkButton } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";

const meta: Meta<typeof PricingCallouts> = {
  title: "Billing/PricingCallouts",
  component: PricingCallouts,
};

export default meta;

type Story = StoryObj<typeof PricingCallouts>;

export const Callouts: Story = {
  render: (args) => <PricingCallouts />,
};

function PricingCallouts() {
  return (
    <div className="mx-4 flex h-screen flex-col items-center justify-center gap-4">
      <Callout
        variant={"pricing"}
        cta={
          <LinkButton
            variant={"primary/small"}
            LeadingIcon={ArrowUpCircleIcon}
            leadingIconClassName="pr-0 pl-0.5"
            to="#"
          >
            Upgrade
          </LinkButton>
        }
      >
        Some of your Runs are being queued because your Run concurrency is limited to 50.
      </Callout>
    </div>
  );
}
