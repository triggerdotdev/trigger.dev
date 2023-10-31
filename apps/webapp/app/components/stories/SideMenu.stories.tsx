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

export const Selects: Story = {
  render: (args) => <SideMenuV2 />,
};

function SideMenuV2() {
  return (
    <div className="h-screen w-full bg-background">
      <div className="grid h-full grid-cols-[220px_auto]">
        <SideMenu
          project={{
            id: "cljcy6z4p0005uoi30s7senp1",
            slug: "my-side-project-_NPp",
            name: "My side project",
            organizationId: "cljcy6z3t0002uoi31immqkox",
            createdAt: new Date("2023-06-26T14:22:16.922Z"),
            updatedAt: new Date("2023-06-26T14:22:16.922Z"),
            hasInactiveExternalTriggers: false,
            hasUnconfiguredIntegrations: true,
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
            environments: [
              {
                id: "cljiqt7jz0002uozmgkp4tgq1",
                slug: "dev",
                apiKey: "tr_dev_CwjOTGLt1KGC",
                pkApiKey: "pk_dev_CwjOTGLt1KGC",
                type: "DEVELOPMENT",
                autoEnableInternalSources: true,
                organizationId: "cljcy6z3t0002uoi31immqkox",
                projectId: "cljiqt7ie0000uozmyrh8q5pv",
                orgMemberId: "cljcy6z3u0004uoi3qjmny8ze",
                createdAt: new Date("2023-06-30T15:42:14.399Z"),
                updatedAt: new Date("2023-06-30T15:42:14.399Z"),
                shortcode: "octopus-tentacles",
              },
            ],
            projects: [
              {
                id: "cll264dhr0000uo01rh3rbaqt",
                slug: "1-job-0-runs-project-r6sp",
                name: "1 Job, 0 Runs Project",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-08-08T10:38:09.231Z"),
                updatedAt: new Date("2023-08-08T10:38:09.231Z"),
                _count: {
                  jobs: 1,
                },
              },
              {
                id: "clkbdw9300002uoq7psdu46cg",
                slug: "1-job-project-QZid",
                name: "1 Job Project",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-07-20T16:46:00.444Z"),
                updatedAt: new Date("2023-07-20T16:46:00.444Z"),
                _count: {
                  jobs: 1,
                },
              },
              {
                id: "cln4gjl8i0000upb3gcfas7mx",
                slug: "byo-auth-Q3Qd",
                name: "BYO Auth",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-09-29T10:24:52.290Z"),
                updatedAt: new Date("2023-09-29T10:24:52.290Z"),
                _count: {
                  jobs: 5,
                },
              },
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
              {
                id: "clo74rlag000cup2wn6c6isdr",
                slug: "no-real-tasks-N90K",
                name: "No real tasks",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T11:58:11.081Z"),
                updatedAt: new Date("2023-10-26T11:58:11.081Z"),
                _count: {
                  jobs: 5,
                },
              },
              {
                id: "clo71yzp00008up2wxmf5jgml",
                slug: "no-task-setup-tkH_",
                name: "No-task-setup",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T10:39:57.493Z"),
                updatedAt: new Date("2023-10-26T10:39:57.493Z"),
                _count: {
                  jobs: 0,
                },
              },
              {
                id: "cljiqt7ie0000uozmyrh8q5pv",
                slug: "samejr-nextjs-test-app-RLh3",
                name: "samejr Next.js test app",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-06-30T15:42:14.342Z"),
                updatedAt: new Date("2023-06-30T15:42:14.342Z"),
                _count: {
                  jobs: 2,
                },
              },
              {
                id: "clo7f0ukq004gupbupbd6otm4",
                slug: "test-astro-1-Oo8k",
                name: "Test Astro 1",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T16:45:19.176Z"),
                updatedAt: new Date("2023-10-26T16:45:19.176Z"),
                _count: {
                  jobs: 0,
                },
              },
              {
                id: "clo7a2pux00gsuplvyf38m97t",
                slug: "testing-example-jobs-SSmT",
                name: "Testing example jobs",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T14:26:48.297Z"),
                updatedAt: new Date("2023-10-26T14:26:48.297Z"),
                _count: {
                  jobs: 1,
                },
              },
              {
                id: "clo7avc3s00houplvrajuy55o",
                slug: "testing-nextjs-joke-9KY7",
                name: "Testing-Nextjs-Joke",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T14:49:03.496Z"),
                updatedAt: new Date("2023-10-26T14:49:03.496Z"),
                _count: {
                  jobs: 1,
                },
              },
              {
                id: "clo7bjyhf00ikuplvyok6gtj1",
                slug: "testing-remix-joke-oy9C",
                name: "Testing Remix Joke",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T15:08:12.244Z"),
                updatedAt: new Date("2023-10-26T15:08:12.244Z"),
                _count: {
                  jobs: 1,
                },
              },
              {
                id: "clo7ds4sj003kupbugc0ghuzi",
                slug: "test-remix-3--Luw",
                name: "Test Remix 3",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T16:10:32.900Z"),
                updatedAt: new Date("2023-10-26T16:10:32.900Z"),
                _count: {
                  jobs: 1,
                },
              },
              {
                id: "clo7ck3zo001nupbudgqxc0k7",
                slug: "test-remix-joke-2-T36f",
                name: "Test Remix Joke 2",
                organizationId: "cljcy6z3t0002uoi31immqkox",
                createdAt: new Date("2023-10-26T15:36:18.996Z"),
                updatedAt: new Date("2023-10-26T15:36:18.996Z"),
                _count: {
                  jobs: 1,
                },
              },
            ],
            _count: {
              members: 1,
            },
          }}
        />
        <div className="h-full w-full" />
      </div>
    </div>
  );
}
