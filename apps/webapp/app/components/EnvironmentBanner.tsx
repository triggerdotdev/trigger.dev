import classNames from "classnames";
import invariant from "tiny-invariant";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";

export function EnvironmentBanner() {
  const environment = useCurrentEnvironment();
  invariant(environment, "Environment not found");

  return (
    <>
      <div className="group absolute top-[3.7rem] left-0 z-50 h-6 w-full bg-transparent">
        <div
          className={classNames(
            environment.slug === "live"
              ? "border-orange-500 before:top-[3px] before:text-orange-200 hover:bg-orange-500/30 hover:before:content-['Live_environment']"
              : "border-blue-500 before:top-[3px] before:text-blue-200 hover:bg-blue-500/30 hover:before:content-['Development_environment']",
            "absolute top-[0rem] right-0 h-1 w-full overflow-hidden border-t-2 transition-[height] duration-500 ease-in-out before:absolute before:left-[calc(50%-5rem)] before:text-xs before:transition hover:backdrop-blur-sm group-hover:h-6"
          )}
        />
      </div>
    </>
  );
}
