import { useParams } from "@remix-run/react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RunPage } from "./RunPage";
import { fanOut } from "./scenarios/fanOut";
import { lotsOfErrors } from "./scenarios/lotsOfErrors";
import { simpleRun } from "./scenarios/simpleRun";

// The run page for the design engineer test, mocked for three runs. RunPage.tsx and
// SpanInspector.tsx are forks of the real page, free to be redesigned. Each scenario's data is a
// file in ./scenarios, built with the helpers in ./mockTrace.ts.

const scenarios = new Map([
  ["simple-run", simpleRun],
  ["fan-out", fanOut],
  ["lots-of-errors", lotsOfErrors],
]);

export default function Story() {
  const { scenario: slug } = useParams();
  const scenario = slug ? scenarios.get(slug) : undefined;

  if (!scenario) {
    return <Paragraph className="p-4">There's no scenario called “{slug}”.</Paragraph>;
  }

  // Remounting per scenario starts each one with a fresh selection, filters and layout.
  return <RunPage key={slug} scenario={scenario} />;
}
