import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Header1 } from "~/components/primitives/Headers";
import {
  Sheet,
  SheetContent,
  SheetHeader,
} from "~/components/primitives/Sheet";
import { ClientEndpoint } from "~/presenters/EnvironmentsPresenter.server";
import { RuntimeEnvironmentType } from "../../../../../packages/database/src";

type ConfigureEndpointSheetProps = {
  slug: string;
  endpoint: ClientEndpoint;
  type: RuntimeEnvironmentType;
  onClose: () => void;
};

export function ConfigureEndpointSheet({
  slug,
  endpoint,
  type,
  onClose,
}: ConfigureEndpointSheetProps) {
  return (
    <Sheet
      open={true}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent>
        <SheetHeader>
          <Header1>
            <EnvironmentLabel environment={{ type }} />
          </Header1>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
}
