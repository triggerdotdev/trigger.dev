import { cn } from "~/utils/cn";
import { CheckCircleIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SettingsRow } from "~/components/primitives/SettingsLayout";
import { TextLink } from "~/components/primitives/TextLink";

export type GitHubConnectionState =
  | "loading"
  | "slow"
  | "unavailable"
  | "error"
  | "install"
  | "connect"
  | "connected";

/** Shared by the live connection panel and the onboarding state gallery. */
export function GitHubOnboardingConnection({
  state,
  repository,
  action,
}: {
  state: GitHubConnectionState;
  repository?: { fullName: string; htmlUrl: string };
  action?: ReactNode;
}) {
  const titles: Record<GitHubConnectionState, string> = {
    loading: "Loading GitHub connection…",
    slow: "GitHub is taking longer than expected",
    unavailable: "GitHub integration unavailable",
    error: "Couldn't load GitHub settings",
    install: "Install the GitHub app",
    connect: "Connect your repository",
    connected: "Repository connected",
  };
  const descriptions: Record<GitHubConnectionState, ReactNode> = {
    loading: "Checking your app installation and repository.",
    slow: "Try loading your connection again.",
    unavailable: "Use the Manual or GitHub Actions tab to deploy your tasks.",
    error: "Try loading your connection again.",
    install: "Give Trigger.dev access to the repository you want to deploy from.",
    connect: "Choose the repository that contains your tasks.",
    connected: undefined,
  };
  return (
    <div className="@container">
      {(state === "connect" || state === "connected") && (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <CheckCircleIcon className="size-4 text-success" />
              GitHub app installed
            </span>
          }
        />
      )}
      <SettingsRow
        titleClassName={state === "error" ? "text-error" : undefined}
        className={cn(
          "gap-x-8 gap-y-3 [&>div:last-child]:min-w-0",
          state === "connected"
            ? "grid grid-cols-[minmax(0,1fr)] @md:grid-cols-[auto_minmax(0,1fr)] [&>div:last-child]:justify-end"
            : "flex-wrap [&>div:first-child]:min-w-0 [&>div:first-child]:basis-48"
        )}
        title={
          state === "connected" ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircleIcon className="size-4 shrink-0 text-success" />
              {titles[state]}
            </span>
          ) : (
            titles[state]
          )
        }
        description={descriptions[state]}
        action={
          state === "connected" ? (
            <div className="flex w-full min-w-0 items-center justify-end gap-6">
              {repository && <RepositoryLink repository={repository} />}
              <div className="shrink-0">{action}</div>
            </div>
          ) : (
            action
          )
        }
      />
    </div>
  );
}

function RepositoryLink({ repository }: { repository: { fullName: string; htmlUrl: string } }) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const label = labelRef.current;
    if (!label) return;
    const measure = () => setTruncated(label.scrollWidth > label.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) measure();
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [repository.fullName]);
  return (
    <TextLink
      className="block min-w-0 text-xs"
      to={repository.htmlUrl}
      tooltip={truncated ? repository.fullName : undefined}
    >
      <span ref={labelRef} className="block truncate">
        {repository.fullName}
      </span>
    </TextLink>
  );
}
