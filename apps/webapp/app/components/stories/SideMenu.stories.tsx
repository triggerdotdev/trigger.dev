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
            organizationId: "cljcy6z3t0002uoi31immqkox",
            createdAt: new Date("2023-06-26T14:22:16.922Z"),
            updatedAt: new Date("2023-06-26T14:22:16.922Z"),
            hasInactiveExternalTriggers: false,
            environments: [
              {
                id: "cljcy6z500006uoi3tn6x60rm",
                slug: "prod",
                type: "PRODUCTION",
                apiKey: "tr_prod_8PqUIY6sqTNQ",
                userId: undefined,
              },
              {
                id: "cljcy6z5d0007uoi3y654jzve",
                slug: "dev",
                type: "DEVELOPMENT",
                apiKey: "tr_dev_3Lf8S925OfSN",
                userId: "cljcy4bps0000uoufqzkoq686",
              },
            ],
          }}
          organization={{
            id: "cljcy6z3t0002uoi31immqkox",
            slug: "mr-big-org-b803",
            title: "Mr Big Org",
            maximumExecutionTimePerRunInMs: 900000,
            createdAt: new Date("2023-06-26T14:22:16.889Z"),
            updatedAt: new Date("2023-06-26T14:22:16.889Z"),
            hasUnconfiguredIntegrations: true,
            projects: [
              {
                id: "cljflk1hj01evuo3dnm5hfng2",
                slug: "my-blank-project-qa3s",
                name: "My blank project",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-06-28T10:51:50.024Z"),
                updatedAt: new Date("2023-06-28T10:51:50.024Z"),
                _count: {
                  jobs: 0,
                },
              },
              {
                id: "cljcy6z4p0005uoi30s7senp1",
                slug: "my-side-project-_NPp",
                name: "My side project",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-06-26T14:22:16.922Z"),
                updatedAt: new Date("2023-06-26T14:22:16.922Z"),
                _count: {
                  jobs: 24,
                },
              },
            ],
            memberCount: 2,
          }}
          organizations={[
            {
              id: "cljcy6z3t0002uoi31im435x",
              slug: "mr-big-org-b803",
              title: "Mr Big Org",
              maximumExecutionTimePerRunInMs: 900000,
              createdAt: new Date("2023-06-26T14:22:16.889Z"),
              updatedAt: new Date("2023-06-26T14:22:16.889Z"),
              projects: [
                {
                  id: "cljflk1hjasduo3dnm5hfng2",
                  slug: "my-blank-project-qa3s",
                  name: "My blank project",
                  organizationId: "cljcy6z3t0002uoi31im435x",
                  createdAt: new Date("2023-06-28T10:51:50.024Z"),
                  updatedAt: new Date("2023-06-28T10:51:50.024Z"),
                  _count: {
                    jobs: 0,
                  },
                },
                {
                  id: "cljcy6z4p0005uoi30s7senp1",
                  slug: "my-side-project-_NPp",
                  name: "My side project",
                  organizationId: "cljcy6z3t0002uoi31immqkox",
                  createdAt: new Date("2023-06-26T14:22:16.922Z"),
                  updatedAt: new Date("2023-06-26T14:22:16.922Z"),
                  _count: {
                    jobs: 24,
                  },
                },
              ],
              memberCount: 2,
              hasUnconfiguredIntegrations: false,
            },
            {
              id: "cljcy6z3t0002uoi31immqkox",
              slug: "mr-big-org-b803",
              title: "Acme Inc",
              maximumExecutionTimePerRunInMs: 900000,
              createdAt: new Date("2023-06-26T14:22:16.889Z"),
              updatedAt: new Date("2023-06-26T14:22:16.889Z"),
              projects: [
                {
                  id: "cljflk1hj01evuo3dnm5hfng2",
                  slug: "my-other-project-qa3s",
                  name: "My other project",
                  organizationId: "cljcy6z3t0002uoi31immqkox",
                  createdAt: new Date("2023-06-28T10:51:50.024Z"),
                  updatedAt: new Date("2023-06-28T10:51:50.024Z"),
                  _count: {
                    jobs: 0,
                  },
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
