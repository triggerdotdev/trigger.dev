import { Form } from "@remix-run/react";
import { UserCrossIcon } from "~/assets/icons/UserCrossIcon";
import { Button } from "./primitives/Buttons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./primitives/Tooltip";

export function ImpersonationBanner() {
  return (
    <div>
      <Form action="/resources/impersonation" method="delete" reloadDocument>
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="submit"
                variant="small-menu-item"
                LeadingIcon={UserCrossIcon}
                fullWidth
                textAlignLeft
                className="text-amber-400"
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" className={"text-xs"}>
              Stop impersonating
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Form>
    </div>
  );
}
