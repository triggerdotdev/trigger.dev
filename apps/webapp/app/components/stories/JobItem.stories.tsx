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
          title={""}
          version={""}
          trigger={""}
          id={""}
          properties={[]}
        />
        <JobItem
          to={""}
          icon="github"
          title={""}
          version={""}
          trigger={""}
          id={""}
          properties={[]}
        />
        <JobItem
          to={""}
          icon="slack"
          title={""}
          version={""}
          trigger={""}
          id={""}
          properties={[]}
          disabled={false}
        />
        <JobItem
          to={""}
          icon="webook"
          title={""}
          version={""}
          trigger={""}
          id={""}
          properties={[]}
          disabled={false}
        />
      </JobList>
    </div>
  );
}
