export type GitHubIssue = {
  id: string;
  title: string;
  body: string;
  url: string;
};

export type GitHubIntegration = {
  id: "github";
  getIssue(repo: string, id: string): Promise<GitHubIssue>;
};

// export const github = createIntegration<GitHubIntegration>({
//   id: "github",
//   methods: {
//     getIssue: {
//       request: (repo: string, id: string) => ({
//         url: `
//         https://api.github.com/repos/${repo}/issues/${id}
//       `,
//         method: "GET",
//         headers: {
//           Accept: "application/vnd.github.v3+json",
//         },
//       }),
//       response: (data: any) => ({
//         id: data.id,
//         title: data.title,
//         body: data.body,
//         url: data.html_url,
//       }),
//     },
//   },
// });
