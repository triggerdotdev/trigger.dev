import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Checkbox } from "../primitives/Checkbox";

const meta: Meta = {
  title: "Primitives/Checkboxes",
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof BasicCheckBox>;

export const Basic: Story = {
  render: () => <BasicCheckBox />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/jBqUJJ2d4lU6aSeKIIOBMY/Trigger.dev?type=design&node-id=2577%3A87576&t=ambgtfvgnwXTHmzI-1",
  },
};

function BasicCheckBox() {
  return (
    <div className="grid w-full place-content-center gap-8 p-8">
      <Checkbox variant="simple" label="This is a simple checkbox" />
      <Checkbox variant="button" label="This is a button checkbox" />
      <div className="flex flex-col gap-y-0.5 overflow-hidden rounded-md">
        <Checkbox
          variant="description"
          label="This is a checkbox with a description"
          description="This is a long checkbox description that goes full width. Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks. Note: In addition to repository related resources, the repo scope also grants access to manage organization-owned resources including projects, invitations, team memberships and webhooks. This scope also grants the ability to manage projects owned by users."
        />
        <Checkbox
          variant="description"
          label="This is a checkbox with a description"
          description="This is a long checkbox description that goes full width. Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks. Note: In addition to repository related resources, the repo scope also grants access to manage organization-owned resources including projects, invitations, team memberships and webhooks. This scope also grants the ability to manage projects owned by users."
        />
      </div>
    </div>
  );
}
