import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";

export default function Story() {
  return (
    <div className="space-y-8 divide-y p-8">
      <div className="flex flex-col items-start gap-y-8">
        <EnvironmentLabel environment={{ type: "PRODUCTION" }} />
        <EnvironmentLabel environment={{ type: "STAGING" }} />
        <EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />
        <EnvironmentLabel environment={{ type: "PREVIEW" }} />
      </div>
    </div>
  );
}
