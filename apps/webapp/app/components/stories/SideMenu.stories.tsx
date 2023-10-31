import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { SideMenu } from "../navigation/SideMenu";

const meta: Meta<typeof SideMenuV2> = {
  title: "Components/SideMenu",
  component: SideMenuV2,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof SideMenuV2>;

export const Main: Story = {
  render: (args) => <SideMenuV2 />,
};

function SideMenuV2() {
  return (
    <div className="h-screen w-full bg-background">
      <div className="grid h-full grid-cols-[220px_auto]">
        <SideMenu
          user={{ email: "rick@astley.com" }}
          project={{
            id: "cljcy6z4p0005uoi30s7senp1",
            slug: "my-side-project-_NPp",
            name: "My side project",
            hasInactiveExternalTriggers: false,
          }}
          organization={{
            id: "cljcy6z3t0002uoi31immqkox",
            slug: "mr-big-org-b803",
            title: "Mr Big Org",
            hasUnconfiguredIntegrations: true,
            projects: [
              {
                id: "cljflk1hj01evuo3dnm5hfng2",
                slug: "my-blank-project-qa3s",
                name: "My blank project",
                jobCount: 2,
                hasInactiveExternalTriggers: false,
              },
              {
                id: "cljcy6z4p0005uoi30s7senp1",
                slug: "my-side-project-_NPp",
                name: "My side project",
                jobCount: 24,
                hasInactiveExternalTriggers: false,
              },
            ],
            memberCount: 2,
          }}
          organizations={[
            {
              id: "cljcy6z3t0002uoi31im435x",
              slug: "mr-big-org-b803",
              title: "Mr Big Org",
              projects: [
                {
                  id: "cljflk1hjasduo3dnm5hfng2",
                  slug: "my-blank-project-qa3s",
                  name: "My blank project",
                  jobCount: 2,
                  hasInactiveExternalTriggers: false,
                },
                {
                  id: "cljcy6z4p0005uoi30s7senp1",
                  slug: "my-side-project-_NPp",
                  name: "My side project",
                  jobCount: 24,
                  hasInactiveExternalTriggers: false,
                },
              ],
              memberCount: 2,
              hasUnconfiguredIntegrations: false,
            },
            {
              id: "cljcy6z3t0002uoi31immqkox",
              slug: "mr-big-org-b803",
              title: "Acme Inc",
              projects: [
                {
                  id: "cljflk1hj01evuo3dnm5hfng2",
                  slug: "my-other-project-qa3s",
                  name: "My other project",
                  jobCount: 2,
                  hasInactiveExternalTriggers: false,
                },
              ],
              memberCount: 1,
              hasUnconfiguredIntegrations: false,
            },
          ]}
        />
        <div className="h-full w-full" />
      </div>
    </div>
  );
}
