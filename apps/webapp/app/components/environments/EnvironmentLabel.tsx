import {
  BranchEnvironmentIconSmall,
  DeployedEnvironmentIconSmall,
  DevEnvironmentIconSmall,
  ProdEnvironmentIconSmall,
} from "~/assets/icons/EnvironmentIcons";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { cn } from "~/utils/cn";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEffect, useRef, useState } from "react";

type Environment = Pick<RuntimeEnvironment, "type"> & { branchName?: string | null };

export function EnvironmentIcon({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  if (environment.branchName) {
    return (
      <BranchEnvironmentIconSmall
        className={cn(environmentTextClassName(environment), className)}
      />
    );
  }

  switch (environment.type) {
    case "DEVELOPMENT":
      return (
        <DevEnvironmentIconSmall className={cn(environmentTextClassName(environment), className)} />
      );
    case "PRODUCTION":
      return (
        <ProdEnvironmentIconSmall
          className={cn(environmentTextClassName(environment), className)}
        />
      );
    case "STAGING":
    case "PREVIEW":
      return (
        <DeployedEnvironmentIconSmall
          className={cn(environmentTextClassName(environment), className)}
        />
      );
  }
}

export function EnvironmentCombo({
  environment,
  className,
  iconClassName,
  tooltipSideOffset,
  tooltipSide,
}: {
  environment: Environment;
  className?: string;
  iconClassName?: string;
  tooltipSideOffset?: number;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <span className={cn("flex items-center gap-1.5 text-sm text-text-bright", className)}>
      <EnvironmentIcon
        environment={environment}
        className={cn("size-4.5 shrink-0", iconClassName)}
      />
      <EnvironmentLabel
        environment={environment}
        tooltipSideOffset={tooltipSideOffset}
        tooltipSide={tooltipSide}
      />
    </span>
  );
}

export function EnvironmentLabel({
  environment,
  className,
  tooltipSideOffset = 34,
  tooltipSide = "right",
}: {
  environment: Environment;
  className?: string;
  tooltipSideOffset?: number;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const text = environment.branchName ? environment.branchName : environmentFullTitle(environment);

  useEffect(() => {
    const checkTruncation = () => {
      if (spanRef.current) {
        const isTruncated = spanRef.current.scrollWidth > spanRef.current.clientWidth;
        setIsTruncated(isTruncated);
      }
    };

    checkTruncation();
    // Add resize observer to recheck on window resize
    const resizeObserver = new ResizeObserver(checkTruncation);
    if (spanRef.current) {
      resizeObserver.observe(spanRef.current);
    }

    return () => resizeObserver.disconnect();
  }, [text]);

  const content = (
    <span
      ref={spanRef}
      className={cn("truncate text-left", environmentTextClassName(environment), className)}
    >
      {text}
    </span>
  );

  if (isTruncated) {
    return (
      <SimpleTooltip
        asChild
        button={content}
        content={
          <span ref={spanRef} className={cn("text-left", environmentTextClassName(environment))}>
            {text}
          </span>
        }
        side={tooltipSide}
        variant="dark"
        sideOffset={tooltipSideOffset}
        disableHoverableContent
      />
    );
  }

  return content;
}

export function environmentTitle(environment: Environment, username?: string) {
  if (environment.branchName) {
    return environment.branchName;
  }

  switch (environment.type) {
    case "PRODUCTION":
      return "Prod";
    case "STAGING":
      return "Staging";
    case "DEVELOPMENT":
      return username ? `Dev: ${username}` : "Dev: You";
    case "PREVIEW":
      return "Preview";
  }
}

export function environmentFullTitle(environment: Environment) {
  if (environment.branchName) {
    return environment.branchName;
  }

  switch (environment.type) {
    case "PRODUCTION":
      return "Production";
    case "STAGING":
      return "Staging";
    case "DEVELOPMENT":
      return "Development";
    case "PREVIEW":
      return "Preview";
  }
}

export function environmentTextClassName(environment: Environment) {
  switch (environment.type) {
    case "PRODUCTION":
      return "text-prod";
    case "STAGING":
      return "text-staging";
    case "DEVELOPMENT":
      return "text-dev";
    case "PREVIEW":
      return "text-preview";
  }
}
