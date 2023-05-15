import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Fieldset } from "../primitives/Fieldset";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "@radix-ui/react-label";
import { Input } from "../primitives/Input";
import { Hint } from "../primitives/Hint";
import { FormError } from "../primitives/FormError";
import { FormButtons } from "../primitives/FormButtons";
import { Button } from "../primitives/Buttons";
import { MainCenteredContainer } from "../layout/AppLayout";
import { FormTitle } from "../primitives/FormTitle";
import { Form } from "@remix-run/react";
import { NamedIcon } from "../primitives/NamedIcon";
import { Paragraph, TextLink } from "../primitives/Paragraph";
import { LogoIcon } from "../LogoIcon";

const meta: Meta<typeof Forms> = {
  title: "Primitives/Forms",
  component: Forms,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof Forms>;

export const Basic: Story = {
  args: {
    text: "Action text",
  },

  render: (args) => <Forms />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};

export const Login: Story = {
  args: {
    text: "Action text",
  },

  render: (args) => <LoginForm />,
};

function Forms() {
  return (
    <MainCenteredContainer>
      <div>
        <FormTitle LeadingIcon="organization">
          Create a new Organization
        </FormTitle>
        <Form>
          <Fieldset>
            <InputGroup>
              <Label>Organization name</Label>
              <Input
                placeholder="Your org name"
                required={true}
                defaultValue="Acme Inc."
              />
              <Hint>E.g. your company name or your workspace name.</Hint>
            </InputGroup>

            <InputGroup>
              <Label>Project name</Label>
              <Input placeholder="Your Project name" required={true} />
              <Hint>Your Jobs will live inside this Project.</Hint>
              <FormError>You must enter a project name</FormError>
            </InputGroup>

            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  variant={"primary/small"}
                  TrailingIcon="arrow-right"
                >
                  Create
                </Button>
              }
              cancelButton={<Button variant={"tertiary/small"}>Cancel</Button>}
            />
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}

function LoginForm() {
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
