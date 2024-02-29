import { EnvelopeIcon } from "@heroicons/react/20/solid";
import { Callout } from "~/components/primitives/Callout";

export default function Story() {
  return (
    <div className="grid grid-cols-2">
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Callout variant="info">This is an info callout</Callout>
        <Callout variant="warning">This is a warning callout</Callout>
        <Callout variant="error">This is an error callout</Callout>
        <Callout variant="idea">This is an idea callout</Callout>
        <Callout variant="docs">This is a docs callout</Callout>
        <Callout variant="idea" icon={<EnvelopeIcon className="h-5 w-5 text-green-400" />}>
          This has a custom icon
        </Callout>
      </div>
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Callout to="#" variant="info">
          This is an info callout
        </Callout>
        <Callout to="#" variant="warning">
          This is a warning callout
        </Callout>
        <Callout to="#" variant="error">
          This is an error callout
        </Callout>
        <Callout to="#" variant="idea">
          This is an idea callout
        </Callout>
        <Callout to="#" variant="docs">
          This is a docs callout
        </Callout>
        <Callout to="#" variant="idea" icon={<EnvelopeIcon className="h-5 w-5 text-green-400" />}>
          This has a custom icon
        </Callout>
      </div>
    </div>
  );
}
