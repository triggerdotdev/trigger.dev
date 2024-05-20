import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";

export default function Story() {
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
      <CheckboxWithLabel
        name="Simple checkbox"
        id="check1"
        variant="simple/small"
        label="This is a simple small checkbox"
        disabled={isDisabled}
      />
      <CheckboxWithLabel
        name="Simple checkbox"
        id="check1"
        variant="simple"
        label="This is a simple checkbox"
        disabled={isDisabled}
      />
      <CheckboxWithLabel
        name="Button checkbox"
        id="check2"
        variant="button"
        label="This is a button checkbox"
        disabled={isDisabled}
      />
      <CheckboxWithLabel
        name="Button checkbox"
        id="check2"
        variant="button"
        label="This is a button checkbox with a badge"
        badges={["This is a badge"]}
        disabled={isDisabled}
      />
      <CheckboxWithLabel
        name="Button checkbox"
        id="check2"
        variant="button"
        defaultChecked
        label="This is a button checkbox that's default checked"
        disabled={isDisabled}
      />
      <div className="flex flex-col gap-y-0.5 overflow-hidden rounded-md">
        <CheckboxWithLabel
          name="Description checkbox"
          id="check3"
          variant="description"
          badges={["This is a badge"]}
          label="This is a checkbox with a description and badge"
          description="This is a long checkbox description that goes full width. Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks. Note: In addition to repository related resources, the repo scope also grants access to manage organization-owned resources including projects, invitations, team memberships and webhooks. This scope also grants the ability to manage projects owned by users."
          disabled={isDisabled}
        />
        <CheckboxWithLabel
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
