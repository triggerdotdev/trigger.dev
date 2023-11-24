import { Form } from "@remix-run/react";
import { Paragraph } from "./primitives/Paragraph";
import { Button } from "./primitives/Buttons";
import { UserMinusIcon } from "@heroicons/react/20/solid";

export function ImpersonationBanner() {
  return (
    <div className="w-full">
      <Form action="/resources/impersonation" method="delete" reloadDocument className="w-full">
        <Button
          type="submit"
          variant="small-menu-item"
          LeadingIcon={UserMinusIcon}
          fullWidth
          textAlignLeft
        >
          Stop impersonating
        </Button>
      </Form>
    </div>
  );
}
