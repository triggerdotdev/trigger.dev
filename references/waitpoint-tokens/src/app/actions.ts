"use server";

import type { articleWorkflow } from "@/trigger/articleWorkflow";
import type { ReviewPayload } from "@/trigger/reviewSummary";
import { tasks, wait } from "@trigger.dev/sdk/v3";

// A user identifier that could be fetched from your auth mechanism.
// This is out of scope for this example, so we just hardcode it.
const user = "reactflowtest";
const userTag = `user_${user}`;

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
  const uniqueTag = `reactflow_${randomStr(20)}`;

  const reviewWaitpointToken = await wait.createToken({
    tags: [uniqueTag, userTag],
    timeout: "1h",
    idempotencyKey: `review-summary-${uniqueTag}`,
  });

  const handle = await tasks.trigger<typeof articleWorkflow>(
    "article-workflow",
    {
      articleUrl,
      approvalWaitpointTokenId: reviewWaitpointToken.id,
    },
    {
      tags: [uniqueTag, userTag],
    }
  );

  return {
    articleUrl,
    runId: handle.id,
    runTag: uniqueTag,
    reviewWaitpointTokenId: reviewWaitpointToken.id,
  };
}

export async function approveArticleSummary(tokenId: string) {
  await wait.completeToken<ReviewPayload>(
    { id: tokenId },
    {
      approved: true,
      approvedAt: new Date(),
      approvedBy: user,
    }
  );
}

export async function rejectArticleSummary(tokenId: string) {
  await wait.completeToken<ReviewPayload>(
    { id: tokenId },
    {
      approved: false,
      rejectedAt: new Date(),
      rejectedBy: user,
      reason: "It's no good",
    }
  );
}
