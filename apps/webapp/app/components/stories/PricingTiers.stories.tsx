import type { Meta, StoryObj } from "@storybook/react";
import { PricingTiers, TierEnterprise, TierFree, TierPro } from "../billing/PricingTiers";

const meta: Meta<typeof AllPricingTiers> = {
  title: "Billing/PricingTiers",
  component: AllPricingTiers,
};

export default meta;

type Story = StoryObj<typeof AllPricingTiers>;

export const AllTiers: Story = {
  render: (args) => <AllPricingTiers />,
};

function AllPricingTiers() {
  return (
    <div className="mx-4 flex h-screen flex-col items-center justify-center gap-4">
      <PricingTiers className="w-[80rem]">
        <TierFree />
        <TierPro />
        <TierEnterprise />
      </PricingTiers>
    </div>
  );
}
