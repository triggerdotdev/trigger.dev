import classNames from "classnames";
import { useCurrentEnvironment } from "~/routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug";
import { Body } from "./primitives/text/Body";

export function EnvironmentBanner() {
  const environment = useCurrentEnvironment();

  return (
    <>
      <div
        className={classNames(
          environment.slug === "live"
            ? `border-liveEnv-500`
            : `border-devEnv-500`,
          "group absolute top-[3.6rem] left-0 z-50 w-full border-t-2 bg-transparent"
        )}
      >
        <div className="absolute top-0 flex w-full items-center justify-center uppercase">
          {environment.slug === "live" ? (
            <Body
              size="extra-small"
              className="rounded-b bg-liveEnv-500 px-3 py-1.5 font-semibold tracking-wide text-liveEnv-900"
            >
              Live
            </Body>
          ) : (
            <Body
              size="extra-small"
              className="rounded-b bg-devEnv-500  px-3 py-1.5 font-semibold tracking-wide text-devEnv-900"
            >
              Development
            </Body>
          )}
        </div>
      </div>
    </>
  );
}
