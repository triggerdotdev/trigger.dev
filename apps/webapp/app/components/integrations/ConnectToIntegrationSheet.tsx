import React, { useState } from "react";
import { Integration } from "~/services/externalApis/types";
import { Header1 } from "../primitives/Headers";
import { NamedIconInBox } from "../primitives/NamedIcon";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "../primitives/Sheet";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";

type IntegrationMethod = "apikey" | "oauth2" | "custom";

export function ConnectToIntegrationSheet({
  integration,
  organizationId,
  button,
  className,
}: {
  integration: Integration;
  organizationId: string;
  button: React.ReactNode;
  className?: string;
}) {
  const [integrationMethod, setIntegrationMethod] = useState<
    IntegrationMethod | undefined
  >(undefined);

  return (
    <Sheet>
      <SheetTrigger className={className}>{button}</SheetTrigger>
      <SheetContent size="lg">
        <SheetHeader>
          <NamedIconInBox name={integration.identifier} className="h-9 w-9" />
          <Header1>{integration.name}</Header1>
        </SheetHeader>
        <SheetBody>
          <RadioGroup name="method" className="flex gap-2">
            {Object.values(integration.authenticationMethods).some(
              (s) => s.type === "apikey"
            ) && (
              <RadioGroupItem
                id="apikey"
                value="apikey"
                label="API Key"
                description="Use API keys in your code. They never leave your server."
                variant="description"
              />
            )}
            {Object.values(integration.authenticationMethods).some(
              (s) => s.type === "oauth2"
            ) && (
              <RadioGroupItem
                id="oauth2"
                value="oauth2"
                label="OAuth"
                description="We handle OAuth for you or your users."
                variant="description"
              />
            )}
            <RadioGroupItem
              id="custom"
              value="custom"
              label="Fetch/Existing SDK"
              description={`Alternatively, use ${integration.name} without our integration.`}
              variant="description"
            />
          </RadioGroup>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

type RadioGroupProps = {
  value: string;
  onChange: (value: string) => void;
  options: RadioGroupOption[];
  className?: string;
};

type RadioGroupOption = {
  label: string;
  value: string;
  description?: string;
};

// function RadioGroup({ value, onChange, options,className }: RadioGroupProps) {
//   return (
//     <div className={cn("", className)}>
//       {options.map((option) => (
//         <RadioGroupOption
//           key={option.value}
//           label={option.label}
//           value={option.value}
//           description={option.description}
//           checked={value === option.value}
//           onChange={onChange}
//         />
//       ))}
//     </div>
//   );
// }
