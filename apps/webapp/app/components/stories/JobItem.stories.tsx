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
    <div className="h-full w-full p-48">
      <JobList>
        <JobItem
          to={""}
          icon="airtable"
          title="When a Stripe payment fails re-engage the customer"
          version="3.4.6"
          trigger="When a Stripe payment fails"
          id="my-custom-job"
          properties={[{ key: "Repo", value: "triggerdotdet/trigger.dev" }]}
        />
        <JobItem
          to={""}
          icon="github"
          title="Notify me of critical issues in Slack"
          version="3.4.5"
          trigger="Critical issue in GitHub"
          id="my-custom-job"
          properties={[{ key: "Repo", value: "triggerdotdet/trigger.dev" }]}
        />
        <JobItem
          to={""}
          icon="slack"
          title="Post to Slack when a new User signs up"
          version="3.4.4"
          trigger="When a new User signs up"
          id="my-custom-job"
          properties={[{ key: "Repo", value: "triggerdotdet/trigger.dev" }]}
          disabled={true}
        />
      </JobList>
    </div>
  );
}
