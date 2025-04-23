import { ArrowRightIcon, BuildingOffice2Icon, FolderIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";

export default function Story() {
  return (
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon={<BuildingOffice2Icon className="size-6 text-fuchsia-600" />}
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
                icon={BuildingOffice2Icon}
              />
              <Hint>E.g. your company name or your workspace name.</Hint>
            </InputGroup>

            <InputGroup>
              <Label>Project name</Label>
              <Input placeholder="Your Project name" required={true} icon={FolderIcon} />
              <FormError>You must enter a project name</FormError>
              <Hint>Your Jobs will live inside this Project.</Hint>
            </InputGroup>

            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"} TrailingIcon={ArrowRightIcon}>
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
