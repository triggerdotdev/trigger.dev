import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { LinkButton } from "../primitives/Buttons";
import {
  PageHeader,
  PageTitleRow,
  PageTitle,
  PageButtons,
  PageDescription,
} from "../primitives/PageHeader";
import { RemixBrowser } from "@remix-run/react";
import { MainContainer } from "../layout/AppLayout";

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
    <div className="flex flex-col gap-4">
      <MainContainer>
        <PageHeader>
          <PageTitleRow>
            <PageTitle
              title="Your Organizations"
              backButton={{ to: "#", text: "Orgs" }}
            />
            <PageButtons>
              <LinkButton to={""} variant="primary/small" shortcut="N">
                Create a new Organization
              </LinkButton>
            </PageButtons>
          </PageTitleRow>
          <PageDescription>
            Create new Organizations and new Projects to help organize your
            Jobs.
          </PageDescription>
        </PageHeader>
      </MainContainer>
    </div>
  );
}
