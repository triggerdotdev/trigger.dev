import { NextResponse } from "next/server";
import { wait, auth } from "@trigger.dev/sdk";

// Verify Slack requests middleware
function verifySlackRequest(request: Request) {
  // TODO: Implement Slack request verification using signing secret
  // https://api.slack.com/authentication/verifying-requests-from-slack
  return true;
}

export async function POST(request: Request) {
  // Verify the request is from Slack
  if (!verifySlackRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    // Parse the urlencoded body from Slack
    const formData = await request.formData();
    const payload = JSON.parse(formData.get("payload") as string);

    console.log("Received Slack payload:", JSON.stringify(payload, null, 2));

    // Extract the action and values
    const action = payload.actions[0];
    const value = JSON.parse(action.value);
    const { tokenId, publicAccessToken, action: actionType } = value;

    console.log("Parsed action values:", { tokenId, actionType });

    await auth.withAuth({ accessToken: publicAccessToken }, async () => {
      // Complete the token based on the action
      if (actionType === "approve") {
        console.log("Completing token with approval");
        await wait.completeToken(tokenId, { approved: true });
      } else if (actionType === "deny") {
        console.log("Completing token with denial");
        await wait.completeToken(tokenId, { approved: false });
      }
    });

    // Update the message to show it's been processed
    const blocks = payload.message.blocks.filter((block: any) => block.type !== "actions");
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `✅ ${actionType === "approve" ? "Approved" : "Denied"} by <@${
            payload.user.id
          }> at ${new Date().toLocaleTimeString()}`,
        },
      ],
    });

    // Send the update to Slack's response_url
    const updateResponse = await fetch(payload.response_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replace_original: true,
        text: actionType === "approve" ? "Query approved" : "Query denied",
        blocks,
      }),
    });

    if (!updateResponse.ok) {
      console.error("Failed to update Slack message:", await updateResponse.text());
    }

    // Return an empty 200 OK response
    return new NextResponse(null, { status: 200 });
  } catch (error) {
    console.error("Error processing Slack interaction:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
