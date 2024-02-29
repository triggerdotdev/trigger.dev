import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { LinkButton } from "../primitives/Buttons";
import { NavBar, PageTitle, PageAccessories } from "../primitives/PageHeader";

const meta: Meta<typeof PageHeaders> = {
  title: "Primitives/PageHeaders",
  component: PageHeaders,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof PageHeaders>;

export const Basic: Story = {
  args: {
    text: "Action text",
  },

  render: (args) => <PageHeaders />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};

function PageHeaders() {
  return (
    <div className="flex flex-col gap-4 bg-charcoal-800 p-4">
      <div className="bg-[#0B1018]">
        <NavBar>
          <PageTitle title="Organizations" />
          <PageAccessories>
            <LinkButton to={""} variant="primary/small" shortcut={{ key: "n" }}>
              Create a new Organization
            </LinkButton>
          </PageAccessories>
        </NavBar>
      </div>
      <div className="bg-[#0B1018]">
        <NavBar>
          <PageTitle title="Your Organizations" backButton={{ to: "#", text: "Orgs" }} />
          <PageAccessories>
            <LinkButton to={""} variant="primary/small" shortcut={{ key: "n" }}>
              Create a new Organization
            </LinkButton>
          </PageAccessories>
        </NavBar>
      </div>
    </div>
  );
}
