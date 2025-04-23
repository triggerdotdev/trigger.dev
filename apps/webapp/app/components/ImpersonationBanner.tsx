import { UserMinusIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { Button } from "./primitives/Buttons";

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
          className="text-amber-400"
        >
          Stop impersonating
        </Button>
      </Form>
    </div>
  );
}
