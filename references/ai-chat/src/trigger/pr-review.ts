import { chat } from "@trigger.dev/sdk/ai";
import { logger, prompts } from "@trigger.dev/sdk";
import {
  streamText,
  generateObject,
  stepCountIs,
  createProviderRegistry,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";
import {
  parseGitHubUrl,
  cloneRepo,
  cleanupClone,
  githubApi,
} from "@/lib/pr-review-helpers";
import {
  repo,
  prReviewTools,
  type PRReviewUiMessage,
} from "@/lib/pr-review-tools";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const registry = createProviderRegistry({ openai, anthropic });

// #region System prompt
const prReviewSystemPrompt = prompts.define({
  id: "pr-review-system",
  model: "anthropic:claude-sonnet-4-6",
  content: `You are an expert code reviewer with deep knowledge of software engineering best practices, security vulnerabilities, performance patterns, and clean code principles.

## Your workflow
1. When the user asks to review a PR, ALWAYS use the fetchPR tool first to load the PR data.
2. Read the diff carefully. For any file where the diff is unclear, use readFile to see the full context.
3. When you spot a potential issue, USE the executeCode tool to verify your claim before stating it. Don't say "this might fail" — prove it.
4. When suggesting a fix, use executeCode to verify the fix works before presenting it.

## Review format
Structure your review as:

### Summary
One paragraph overview of the PR's purpose and scope.

### Findings
For each issue, use severity markers:
- 🔴 **Bug**: Definite or highly likely bugs, data loss risks, security vulnerabilities
- 🟡 **Suggestion**: Improvements to readability, performance, maintainability
- 🟢 **Nitpick**: Style preferences, naming, minor improvements

Format each finding as:
**[severity] filename:line — Brief title**
Description of the issue. Reference exact code from the diff.

### Overall Assessment
Is this PR ready to merge, needs minor changes, or needs significant rework?

## Rules
- Be specific. Always cite filenames and line numbers from the diff.
- Be constructive. Explain WHY something is a problem and suggest a fix.
- Don't flag intentional patterns as bugs — use readFile to check context first.
- Don't hallucinate line numbers. Use the diff hunks or readFile output.
- If the diff is truncated, tell the user and offer to read specific files.
- Verify non-obvious claims with executeCode before including them.`,
});
// #endregion

// #region Self-review prompt
const prSelfReviewPrompt = prompts.define({
  id: "pr-review-self-review",
  model: "anthropic:claude-haiku-4-5",
  content: `You are a code review quality checker. Analyze the reviewer's comments for accuracy.

Focus on:
- False positive bugs (code flagged as buggy that is actually correct)
- Incorrect assumptions about the code's behavior
- Claims that weren't verified by running code
- Overstated severity levels

Be concise. Only flag genuine issues.`,
});
// #endregion

// #region Shared init helper
async function initRepo(chatId: string, userId: string, githubUrl: string) {
  // 1. Look up user and their GitHub token from the database
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const githubToken = user?.githubToken ?? null;

  // 2. Parse the GitHub URL and clone the repo
  const { owner, repo: repoName } = parseGitHubUrl(githubUrl);
  const cwd = `/tmp/pr-review-${chatId}`;

  await cloneRepo({ owner, repo: repoName, clonePath: cwd, token: githubToken });

  // 3. Fetch open PRs from GitHub API
  const prs = await githubApi<
    Array<{
      number: number;
      title: string;
      user: { login: string };
      head: { ref: string };
    }>
  >(`/repos/${owner}/${repoName}/pulls?state=open&per_page=20&sort=updated`, githubToken);

  const openPRs = prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user.login,
    headBranch: pr.head.ref,
  }));

  // 4. Initialize per-run state
  repo.init({
    cwd,
    owner,
    repo: repoName,
    githubToken,
    openPRs,
    activePR: null,
  });

  // 5. Resolve and set system prompt
  const resolved = await prReviewSystemPrompt.resolve({});
  chat.prompt.set(resolved);

  logger.info("PR review state initialized", {
    owner,
    repo: repoName,
    cwd,
    openPRCount: openPRs.length,
    hasToken: !!githubToken,
  });
}
// #endregion

// #region Agent definition
export const prReviewChat = chat
  .withUIMessage<PRReviewUiMessage>({
    streamOptions: {
      sendReasoning: true,
      onError: (error) => {
        logger.error("PR review stream error", { error });
        return "Something went wrong during review. Please try again.";
      },
    },
  })
  .withClientData({
    schema: z.object({
      userId: z.string(),
      githubUrl: z.string().url(),
    }),
  })
  .agent({
    id: "pr-review",
    idleTimeoutInSeconds: 10,
    preloadIdleTimeoutInSeconds: 10,
    chatAccessTokenTTL: "60m",

    // #region onPreload — clone repo + fetch PRs before first message
    onPreload: async ({ chatId, clientData }) => {
      if (!clientData) return;
      await initRepo(chatId, clientData.userId, clientData.githubUrl);
    },
    // #endregion

    // #region onChatStart — fallback init when not preloaded
    onChatStart: async ({ chatId, clientData, preloaded }) => {
      if (preloaded) return;
      await initRepo(chatId, clientData.userId, clientData.githubUrl);
    },
    // #endregion

    // #region onTurnComplete — self-review for false positives
    onTurnComplete: async ({ messages }) => {
      chat.defer(
        (async () => {
          const resolved = await prSelfReviewPrompt.resolve({});

          const review = await generateObject({
            model: anthropic("claude-haiku-4-5-20251001"),
            ...resolved.toAISDKTelemetry(),
            system: resolved.text,
            prompt: `Review the code reviewer's latest response for accuracy:\n\n${messages
              .filter((m) => m.role === "user" || m.role === "assistant")
              .slice(-4)
              .map(
                (m) =>
                  `${m.role}: ${
                    typeof m.content === "string"
                      ? m.content
                      : Array.isArray(m.content)
                        ? m.content
                            .filter((p: any) => p.type === "text")
                            .map((p: any) => p.text)
                            .join("")
                        : ""
                  }`
              )
              .join("\n\n")}`,
            schema: z.object({
              hasFalsePositives: z
                .boolean()
                .describe("Whether the review contains false positives"),
              corrections: z.array(
                z.object({
                  originalClaim: z
                    .string()
                    .describe("The claim from the review"),
                  correction: z
                    .string()
                    .describe("What should be corrected"),
                  severity: z.enum([
                    "false-positive-bug",
                    "overstated-severity",
                    "missing-context",
                  ]),
                })
              ),
            }),
          });

          if (
            review.object.hasFalsePositives &&
            review.object.corrections.length > 0
          ) {
            const correctionText = review.object.corrections
              .map(
                (c) =>
                  `- ${c.severity}: "${c.originalClaim}" → ${c.correction}`
              )
              .join("\n");

            chat.inject([
              {
                role: "user" as const,
                content: `[Self-review correction]\n\nYour previous review may contain inaccuracies:\n${correctionText}\n\nIncorporate these corrections naturally if the user asks follow-up questions.`,
              },
            ]);
          }
        })()
      );
    },
    // #endregion

    // #region onComplete — cleanup clone directory
    onComplete: async () => {
      await cleanupClone(repo.cwd);
    },
    // #endregion

    // #region run — stream code review response
    run: async ({ messages, stopSignal }) => {
      // Inject open PR list as context so the agent knows what's available
      const prListContext =
        repo.openPRs.length > 0
          ? `Open PRs for ${repo.owner}/${repo.repo}:\n${repo.openPRs
              .map(
                (pr) =>
                  `  #${pr.number} — ${pr.title} (by ${pr.author}, branch: ${pr.headBranch})`
              )
              .join("\n")}`
          : "";

      return streamText({
        ...chat.toStreamTextOptions({ registry }),
        model: anthropic("claude-sonnet-4-6"),
        messages: prListContext
          ? [
              {
                role: "user" as const,
                content: `[Context] ${prListContext}`,
              },
              ...messages,
            ]
          : messages,
        tools: prReviewTools,
        stopWhen: stepCountIs(15),
        abortSignal: stopSignal,
        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 10000 },
          },
        },
      });
    },
    // #endregion
  });
// #endregion
