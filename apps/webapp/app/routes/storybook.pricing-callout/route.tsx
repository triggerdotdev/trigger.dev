import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";

export default function Story() {
  return (
    <div className="mx-4 flex h-screen flex-col items-center justify-center gap-4">
      <Callout
        variant={"pricing"}
        cta={
          <LinkButton
            variant={"primary/small"}
            LeadingIcon={ArrowUpCircleIcon}
            leadingIconClassName="pr-0 pl-0.5"
            to="#"
          >
            Upgrade
          </LinkButton>
        }
      >
        Some of your runs are being queued because your run concurrency is limited to 50.
      </Callout>
    </div>
  );
}
