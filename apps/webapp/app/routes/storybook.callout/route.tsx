import { EnvelopeIcon } from "@heroicons/react/20/solid";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";

export default function Story() {
  return (
    <div className="grid grid-cols-2">
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Header2>Callouts</Header2>
        <Callout variant="info">This is an info callout</Callout>
        <Callout variant="warning">This is a warning callout</Callout>
        <Callout variant="error">This is an error callout</Callout>
        <Callout variant="idea">This is an idea callout</Callout>
        <Callout variant="success">This is a success callout</Callout>
        <Callout variant="docs">This is a docs callout</Callout>
        <Callout variant="success" icon={<EnvelopeIcon className="h-5 w-5 text-green-400" />}>
          This callout has a custom icon
        </Callout>
        <Callout variant="pending">This is a pending callout</Callout>
        <Callout variant="pricing">This is a pricing callout</Callout>
        <Callout variant="error">
          This is an error message which runs over multiple lines. This is an error message which
          runs over multiple lines. This is an error message which runs over multiple lines.
        </Callout>
      </div>
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Header2>Callouts with a link</Header2>
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
          This callout has a custom icon
        </Callout>
        <Callout to="#" variant="pending">
          This is a pending callout
        </Callout>
        <Callout to="#" variant="pricing">
          This is a pricing callout
        </Callout>
        <Callout variant="info" to="https://google.com">
          This uses an http link
        </Callout>
        <Callout to="#" variant="error">
          This is an error message which runs over multiple lines. This is an error message which
          runs over multiple lines. This is an error message which runs over multiple lines.
        </Callout>
      </div>
    </div>
  );
}
