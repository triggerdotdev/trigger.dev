import { GitPullRequestIcon, GitCommitIcon, GitBranchIcon } from "lucide-react";
import { type GitMetaLinks } from "~/presenters/v3/BranchesPresenter.server";
import { LinkButton } from "./primitives/Buttons";

export function GitMetadata({ git }: { git?: GitMetaLinks | null }) {
  if (!git) return null;
  return (
    <>
      {git.branchUrl && <GitMetadataBranch git={git} />}
      {git.shortSha && <GitMetadataCommit git={git} />}
      {git.pullRequestUrl && git.pullRequestNumber && <GitMetadataPullRequest git={git} />}
    </>
  );
}

export function GitMetadataBranch({
  git,
}: {
  git: Pick<GitMetaLinks, "branchUrl" | "branchName">;
}) {
  return (
    <LinkButton
      variant="minimal/small"
      LeadingIcon={<GitBranchIcon className="size-4" />}
      iconSpacing="gap-x-1"
      to={git.branchUrl}
      className="pl-1"
    >
      {git.branchName}
    </LinkButton>
  );
}

export function GitMetadataCommit({
  git,
}: {
  git: Pick<GitMetaLinks, "commitUrl" | "shortSha" | "commitMessage">;
}) {
  return (
    <LinkButton
      variant="minimal/small"
      to={git.commitUrl}
      LeadingIcon={<GitCommitIcon className="size-4" />}
      iconSpacing="gap-x-1"
      className="pl-1"
    >
      {`${git.shortSha} / ${git.commitMessage}`}
    </LinkButton>
  );
}

export function GitMetadataPullRequest({
  git,
}: {
  git: Pick<GitMetaLinks, "pullRequestUrl" | "pullRequestNumber">;
}) {
  if (!git.pullRequestUrl || !git.pullRequestNumber) return null;

  return (
    <LinkButton
      variant="minimal/small"
      to={git.pullRequestUrl}
      LeadingIcon={<GitPullRequestIcon className="size-4" />}
      iconSpacing="gap-x-1"
      className="pl-1"
    >
      #{git.pullRequestNumber}
    </LinkButton>
  );
}
