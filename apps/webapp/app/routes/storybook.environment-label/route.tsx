import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Header2 } from "~/components/primitives/Headers";

export default function Story() {
  return (
    <div className="space-y-8 divide-y p-8">
      <div className="flex flex-col items-start gap-y-8">
        <Header2>Small (default)</Header2>
        <EnvironmentLabel environment={{ type: "PRODUCTION" }} />
        <EnvironmentLabel environment={{ type: "STAGING" }} />
        <EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />
        <EnvironmentLabel environment={{ type: "PREVIEW" }} />
      </div>
      <div className="flex flex-col items-start gap-y-8 pt-8">
        <Header2>Large</Header2>
        <EnvironmentLabel environment={{ type: "PRODUCTION" }} size="large" />
        <EnvironmentLabel environment={{ type: "STAGING" }} size="large" />
        <EnvironmentLabel environment={{ type: "DEVELOPMENT" }} size="large" />
        <EnvironmentLabel environment={{ type: "PREVIEW" }} size="large" />
      </div>
    </div>
  );
}
