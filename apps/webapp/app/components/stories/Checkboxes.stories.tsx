import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Checkbox } from "../primitives/Checkbox";
import { useState } from "react";
import { Button } from "../primitives/Buttons";

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
  const [isDisabled, setIsDisabled] = useState(false);

  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <Button
        onClick={() => setIsDisabled((d) => !d)}
        variant="primary/medium"
        className="max-w-fit"
      >
        {isDisabled ? "Enable checkboxes" : "Disable checkboxes"}
      </Button>
      <Checkbox
        name="Simple checkbox"
        id="check1"
        variant="simple"
        label="This is a simple checkbox"
        disabled={isDisabled}
      />
      <Checkbox
        name="Button checkbox"
        id="check2"
        variant="button"
        label="This is a button checkbox"
        disabled={isDisabled}
      />
      <Checkbox
        name="Button checkbox"
        id="check2"
        variant="button"
        label="This is a button checkbox with a badge"
        badges={["This is a badge"]}
        disabled={isDisabled}
      />
      <Checkbox
        name="Button checkbox"
        id="check2"
        variant="button"
        defaultChecked
        label="This is a button checkbox that's default checked"
        disabled={isDisabled}
      />
      <div className="flex flex-col gap-y-0.5 overflow-hidden rounded-md">
        <Checkbox
          name="Description checkbox"
          id="check3"
          variant="description"
          badges={["This is a badge"]}
          label="This is a checkbox with a description and badge"
          description="This is a long checkbox description that goes full width. Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks. Note: In addition to repository related resources, the repo scope also grants access to manage organization-owned resources including projects, invitations, team memberships and webhooks. This scope also grants the ability to manage projects owned by users."
          disabled={isDisabled}
        />
        <Checkbox
          name="Description checkbox"
          id="check4"
          variant="description"
          label="This is a checkbox with a description"
          description="This is a long checkbox description that goes full width. Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks. Note: In addition to repository related resources, the repo scope also grants access to manage organization-owned resources including projects, invitations, team memberships and webhooks. This scope also grants the ability to manage projects owned by users."
          disabled={isDisabled}
        />
      </div>
    </div>
  );
}
