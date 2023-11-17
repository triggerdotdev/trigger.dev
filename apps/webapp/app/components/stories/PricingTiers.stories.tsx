import type { Meta, StoryObj } from "@storybook/react";
import { PricingTiers, TierEnterprise, TierFree, TierPro } from "../billing/PricingTiers";

const meta: Meta<typeof AllPricingTiers> = {
  title: "Components/PricingTiers",
  component: AllPricingTiers,
};

export default meta;

type Story = StoryObj<typeof AllPricingTiers>;

export const AllTiers: Story = {
  render: (args) => <AllPricingTiers />,
};

function AllPricingTiers() {
  return (
    <div className="mx-4 flex h-screen items-center justify-center">
      <PricingTiers className="">
        <TierFree />
        <TierPro />
        <TierEnterprise />
      </PricingTiers>
    </div>
  );
}
