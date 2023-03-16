import classNames from "classnames";
import invariant from "tiny-invariant";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { Body } from "./primitives/text/Body";

export function EnvironmentBanner() {
  const environment = useCurrentEnvironment();
  invariant(environment, "Environment not found");

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
        <div className="absolute top-0 flex w-full items-center justify-center uppercase opacity-0 transition-opacity duration-500 group-hover:opacity-100">
          {environment.slug === "live" ? (
            <Body
              size="extra-small"
              className="rounded-b bg-liveEnv-500 px-3 py-1.5 font-semibold tracking-wide text-liveEnv-900"
            >
              Live environment
            </Body>
          ) : (
            <Body
              size="extra-small"
              className="rounded-b bg-devEnv-500  px-3 py-1.5 font-semibold tracking-wide text-devEnv-900"
            >
              Development environment
            </Body>
          )}
        </div>
      </div>
    </>
  );
}
