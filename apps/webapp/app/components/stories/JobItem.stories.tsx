import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { JobItem, JobList } from "../jobs/JobItem";

const meta: Meta<typeof Jobs> = {
  title: "Primitives/Jobs",
  component: Jobs,
  decorators: [withDesign],
  tags: ["autodocs"],
};

export default meta;

type Story = StoryObj<typeof Jobs>;

export const Job: Story = {
  render: (args) => <Jobs />,
};

function Jobs() {
  return (
    <div className="h-full w-full">
      <JobList>
        <JobItem
          to={""}
          icon="airtable"
          title="When a Stripe payment fails re-engage the customer"
          version="3.4.6"
          trigger="When a Stripe payment fails"
          integrations={[
            {
              title: "Airtable",
              icon: "airtable",
            },
            {
              title: "GitHub",
              icon: "github",
            },
          ]}
          id="my-custom-job"
          lastRun={{
            status: "TIMED_OUT",
            createdAt: new Date("2021-08-12T12:00:00.000Z"),
          }}
          elements={[{ label: "Repo", text: "triggerdotdet/trigger.dev" }]}
        />
        <JobItem
          to={""}
          icon="github"
          title="Notify me of critical issues in Slack"
          version="3.4.5"
          trigger="Critical issue in GitHub"
          integrations={[
            {
              title: "Slack",
              icon: "slack",
            },
            {
              title: "GitHub",
              icon: "github",
            },
          ]}
          id="my-custom-job"
          lastRun={{
            status: "SUCCESS",
            createdAt: new Date("2021-08-12T12:00:00.000Z"),
          }}
          elements={[
            { label: "Repo", text: "triggerdotdet/trigger.dev" },
            { label: "Element-1", text: "7f9F*9s7df*hdhhh" },
            { label: "Element-2", text: "github/github.com" },
            { label: "Element-3", text: "FH8sdfh(*sd&*Sa8hdj" },
          ]}
        />
        <JobItem
          to={""}
          icon="slack"
          title="Post to Slack when a new User signs up"
          version="3.4.4"
          trigger="When a new User signs up"
          integrations={[
            {
              title: "Slack",
              icon: "slack",
            },
            {
              title: "GitHub",
              icon: "github",
            },
          ]}
          id="my-custom-job"
          elements={[{ label: "Repo", text: "triggerdotdet/trigger.dev" }]}
          disabled={true}
        />
      </JobList>
    </div>
  );
}
