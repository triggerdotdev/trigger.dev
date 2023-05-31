import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Fieldset } from "../primitives/Fieldset";
import { InputGroup } from "../primitives/InputGroup";
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
import { Label } from "../primitives/Label";

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

export const Search: Story = {
  args: {
    text: "Action text",
  },

  render: (args) => <SearchForm />,
};

function Forms() {
  return (
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon="organization"
          title="Create a new Organization"
          description="Organizations are a great way to group your Projects."
        />
        <Form>
          <Fieldset>
            <InputGroup>
              <Label>Organization name</Label>
              <Input
                placeholder="Your org name"
                required={true}
                defaultValue="Acme Inc."
                icon="organization"
              />
              <Hint>E.g. your company name or your workspace name.</Hint>
            </InputGroup>

            <InputGroup>
              <Label>Project name</Label>
              <Input
                placeholder="Your Project name"
                required={true}
                icon="folder"
              />
              <FormError>You must enter a project name</FormError>
              <Hint>Your Jobs will live inside this Project.</Hint>
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
              cancelButton={<Button variant={"secondary/small"}>Cancel</Button>}
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
        <FormTitle divide={false} title="Create your Trigger.dev account" />
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

function SearchForm() {
  return (
    <MainCenteredContainer>
      <div>
        <Form>
          <Fieldset>
            <InputGroup>
              <Label>Medium search input</Label>
              <Input
                placeholder="Search"
                required={true}
                icon="search"
                shortcut="⌘K"
              />
            </InputGroup>
            <InputGroup>
              <Label>Small search input</Label>
              <Input
                placeholder="Search"
                required={true}
                variant="small"
                icon="search"
                shortcut="⌘K"
                fullWidth={false}
              />
            </InputGroup>
            <InputGroup>
              <Label>Tertiary search input</Label>
              <Input
                placeholder="Search"
                required={true}
                variant="tertiary"
                icon="search"
                fullWidth={false}
              />
            </InputGroup>
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
