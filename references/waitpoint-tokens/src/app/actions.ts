"use server";

import type { articleWorkflow } from "@/trigger/articleWorkflow";
import type { ReviewPayload } from "@/trigger/reviewSummary";
import { auth, tasks, wait } from "@trigger.dev/sdk/v3";

const randomStr = (length: number) =>
  [...Array(length)]
    .map(
      () =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
          Math.floor(Math.random() * 62)
        ]
    )
    .join("");

export async function triggerArticleWorkflow(prevState: any, formData: FormData) {
  const articleUrl = formData.get("articleUrl") as string;
  const workflowTag = `reactflow_${randomStr(20)}`;

  const reviewWaitpointToken = await wait.createToken({
    tags: [workflowTag],
    timeout: "1h",
    idempotencyKey: `review-summary-${workflowTag}`,
  });

  const [workflowPublicAccessToken] = await Promise.all([
    // We generate a public access token to use the Trigger.dev realtime API and listen to changes in task runs using react hooks.
    // This token has access to all runs tagged with the unique workflow tag.
    auth.createPublicToken({
      scopes: {
        read: {
          tags: [workflowTag],
        },
      },
    }),
    ,
    tasks.trigger<typeof articleWorkflow>(
      "article-workflow",
      {
        articleUrl,
        approvalWaitpointTokenId: reviewWaitpointToken.id,
      },
      {
        tags: [workflowTag],
      }
    ),
  ]);

  return {
    articleUrl,
    workflowTag,
    workflowPublicAccessToken,
  };
}

export async function approveArticleSummary(tokenId: string) {
  await wait.completeToken<ReviewPayload>(
    { id: tokenId },
    {
      approved: true,
      approvedAt: new Date(),
      approvedBy: "Alice",
    }
  );
}

export async function rejectArticleSummary(tokenId: string) {
  await wait.completeToken<ReviewPayload>(
    { id: tokenId },
    {
      approved: false,
      rejectedAt: new Date(),
      rejectedBy: "Alice",
      reason: "It's no good",
    }
  );
}
