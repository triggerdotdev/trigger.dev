import { UserMinusIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { Button } from "./primitives/Buttons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./primitives/Tooltip";

export function ImpersonationBanner() {
  return (
    <div>
      <Form action="/resources/impersonation" method="delete" reloadDocument>
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger>
              <Button
                type="submit"
                variant="small-menu-item"
                LeadingIcon={UserMinusIcon}
                fullWidth
                textAlignLeft
                className="bg-amber-400 text-background-bright group-hover/button:bg-amber-300"
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
