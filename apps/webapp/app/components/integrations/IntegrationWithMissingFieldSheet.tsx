import { docsIntegrationPath } from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { Header1 } from "../primitives/Headers";
import { NamedIconInBox } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "../primitives/Sheet";
import { SelectOAuthMethod } from "./SelectOAuthMethod";
import { Integration } from "~/services/externalApis/types";
import { Client } from "~/presenters/IntegrationsPresenter.server";

export function IntegrationWithMissingFieldSheet({
  integration,
  organizationId,
  button,
  callbackUrl,
  existingIntegration,
  className,
}: {
  integration: Integration;
  organizationId: string;
  button: React.ReactNode;
  callbackUrl: string;
  existingIntegration: Client;
  className?: string;
}) {
  return (
    <Sheet>
      <SheetTrigger className={className}>{button}</SheetTrigger>
      <SheetContent size="lg" className="relative">
        <SheetHeader>
          <NamedIconInBox name={integration.identifier} className="h-9 w-9" />
          <div className="grow">
            <Header1>{integration.name}</Header1>
            {integration.description && (
              <Paragraph variant="small">{integration.description}</Paragraph>
            )}
          </div>
          <LinkButton
            to={docsIntegrationPath(integration.identifier)}
            variant="secondary/small"
            LeadingIcon="docs"
            target="_blank"
          >
            View docs
          </LinkButton>
        </SheetHeader>
        <SheetBody>
          <SelectOAuthMethod
            integration={integration}
            organizationId={organizationId}
            callbackUrl={callbackUrl}
            existingIntegration={existingIntegration}
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
