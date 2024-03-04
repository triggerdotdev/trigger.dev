import { Form } from "@remix-run/react";
import { LogoIcon } from "~/components/LogoIcon";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormTitle } from "~/components/primitives/FormTitle";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";

export default function Story() {
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
                className={"mr-1.5 h-4 w-4 transition group-hover:text-text-bright"}
              />
              Continue with Email
            </Button>
            <Paragraph variant="small" className="mt-2 text-center">
              By creating an account you agree to our <TextLink href="#">terms</TextLink> and{" "}
              <TextLink href="#">privacy</TextLink> policies.
            </Paragraph>
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
