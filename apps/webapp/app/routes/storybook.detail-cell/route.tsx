import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClockIcon,
  CodeBracketIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import { DateTime } from "~/components/primitives/DateTime";
import { DetailCell } from "~/components/primitives/DetailCell";

export default function Story() {
  return (
    <div className="flex max-w-xl flex-col items-start gap-y-8 p-8">
      <DetailCell
        leadingIcon={CodeBracketIcon}
        leadingIconClassName="text-text-dimmed"
        label="Learn how to create your own API Integrations"
        variant="base"
        trailingIcon={ArrowTopRightOnSquareIcon}
        trailingIconClassName="text-charcoal-700 group-hover:text-text-bright"
      />
      <DetailCell
        leadingIcon={CodeBracketIcon}
        leadingIconClassName="text-blue-500"
        label="Issue comment created"
        trailingIcon={CheckIcon}
        trailingIconClassName="text-green-500 group-hover:text-green-400"
      />
      <DetailCell
        leadingIcon={ClockIcon}
        leadingIconClassName="text-charcoal-400"
        label={<DateTime date={new Date()} />}
        description="Run #42 complete"
        trailingIcon={PlusIcon}
        trailingIconClassName="text-charcoal-500 group-hover:text-text-bright"
      />
    </div>
  );
}
