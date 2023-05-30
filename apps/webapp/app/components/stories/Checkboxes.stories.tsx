import { Form } from "@remix-run/react";
import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { LogoIcon } from "../LogoIcon";
import { MainCenteredContainer } from "../layout/AppLayout";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Buttons";
import { Fieldset } from "../primitives/Fieldset";
import { FormTitle } from "../primitives/FormTitle";
import { NamedIcon } from "../primitives/NamedIcon";
import { Paragraph, TextLink } from "../primitives/Paragraph";

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
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};

export const CheckboxButtons: Story = {
  render: () => <CheckboxButton />,
};

function BasicCheckBox() {
  return (
    <MainCenteredContainer>
      <fieldset className="flex items-start gap-2">
        <input
          type="checkbox"
          name="scopes"
          value="Scopes name"
          id="123"
          defaultChecked={false}
          className="mt-1"
        />
        <div>
          <div className="flex gap-2">
            <label htmlFor="123">Scopes name</label>
            <Badge
              className="px-1.5 py-0.5 text-xs"
              // style={{ backgroundColor: a.color }}
            >
              Badge
            </Badge>
          </div>
          <p className="text-slate-300">admin:repo_hook, public_repo</p>
        </div>
      </fieldset>
    </MainCenteredContainer>
  );
}

function CheckboxButton() {
  return (
    <MainCenteredContainer>
      <div className="flex flex-col items-center">
        <LogoIcon className="mb-4 h-16 w-16" />
        <FormTitle divide={false}>Create your Trigger.dev account</FormTitle>
        <Form>
          <Fieldset>
            <Button variant="primary/large" fullWidth>
              <NamedIcon name={"github"} className={"mr-1.5 h-4 w-4"} />
              Continue with GitHub
            </Button>
            <Button variant="secondary/large" fullWidth>
              <NamedIcon
                name={"envelope"}
                className={"mr-1.5 h-4 w-4 transition group-hover:text-bright"}
              />
              Continue with Email
            </Button>
            <Paragraph variant="small" className="mt-2 text-center">
              By connecting your GitHub account you agree to our{" "}
              <TextLink href="#">terms</TextLink> and{" "}
              <TextLink href="#">privacy</TextLink> policies.
            </Paragraph>
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
