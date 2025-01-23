import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";

export default function Story() {
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
                icon={MagnifyingGlassIcon}
                shortcut="⌘K"
              />
            </InputGroup>
            <InputGroup>
              <Label>Small search input</Label>
              <Input
                placeholder="Search"
                required={true}
                variant="small"
                icon={MagnifyingGlassIcon}
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
                icon={MagnifyingGlassIcon}
                fullWidth={false}
              />
            </InputGroup>
            <InputGroup>
              <Label variant="small">This is a small label</Label>
              <Input
                placeholder="Search"
                required={true}
                icon={MagnifyingGlassIcon}
                shortcut="⌘K"
              />
            </InputGroup>
            <InputGroup>
              <Label variant="medium">This is a medium label</Label>
              <Input
                placeholder="Search"
                required={true}
                icon={MagnifyingGlassIcon}
                shortcut="⌘K"
              />
            </InputGroup>
            <InputGroup>
              <Label variant="large">This is a large label</Label>
              <Input
                placeholder="Search"
                required={true}
                icon={MagnifyingGlassIcon}
                shortcut="⌘K"
              />
            </InputGroup>
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
