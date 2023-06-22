export function repoProperties(params: { owner: string; repo: string }) {
  return [
    {
      label: "Owner",
      text: params.owner,
    },
    {
      label: "Repo",
      text: params.repo,
    },
  ];
}

export function issueProperties(params: { issueNumber: number }) {
  return [
    {
      label: "Issue",
      text: `#${params.issueNumber}`,
    },
  ];
}
