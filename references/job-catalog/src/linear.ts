import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { Linear, serializeLinearOutput } from "@trigger.dev/linear";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const linear = new Linear({
  id: "linear",
  apiKey: process.env["LINEAR_API_KEY"],
});

client.defineJob({
  id: "linear-create-issue",
  name: "Linear Create Issue",
  version: "0.1.0",
  integrations: { linear },
  trigger: eventTrigger({
    name: "linear.create.issue",
    schema: z.object({
      teamId: z.string().optional(),
      issueTitle: z.string().optional(),
    }),
  }),
  run: async (payload, io, ctx) => {
    const firstTeam = await io.linear.runTask("get-first-team", async (client) => {
      const payload = await client.teams();
      //use helper to serialize raw client output
      return serializeLinearOutput(payload.nodes[0]);
    });

    const issue = await io.linear.createIssue("create-issue", {
      //use optional teamId if passed - ID of first team otherwise
      teamId: payload.teamId ?? firstTeam.id,
      title: payload.issueTitle ?? "Shiny new issue",
    });

    if (issue) {
      //some time to visually inspect and trigger the next job
      await io.wait("10 secs", 10);
      await io.linear.deleteIssue("delete-issue", { id: issue.id });
    } else {
      io.logger.error("Failed to create issue, nothing to delete.");
    }
  },
});

client.defineJob({
  id: "linear-new-issue-reply",
  name: "Linear New Issue Reply",
  version: "0.1.0",
  integrations: {
    linear,
  },
  //this should trigger when creating an issue in the job above
  trigger: linear.onIssueCreated(),
  run: async (payload, io, ctx) => {
    const newIssueId = payload.data.id;

    await io.linear.createComment("create-comment", {
      issueId: newIssueId,
      body: "Thank's for opening this issue!",
    });

    await io.linear.createReaction("create-reaction", {
      issueId: newIssueId,
      emoji: "+1",
    });
  },
});

client.defineJob({
  id: "linear-test-misc",
  name: "Linear Test Misc",
  version: "0.1.0",
  integrations: { linear },
  //this should automatically trigger after the first example
  trigger: linear.onIssueRemoved(),
  run: async (payload, io, ctx) => {
    //info about the currently authenticated user
    await io.linear.viewer("get-viewer");
    await io.linear.organization("get-org");

    const fourDigits = Math.floor(Math.random() * 1000)

    //create an organization
    await io.linear.createOrganizationFromOnboarding("create-org", {
      input: {
        name: "Rickastleydotdev",
        urlKey: `you-know-the-rules-${fourDigits}`,
      },
    });

    //create invite
    //DISABLED: Linear responds with internal server errors, no matter the input
    // await io.linear.createOrganizationInvite("create-invite", {
    //   input: {
    //     email: `rick${fourDigits}@example.com`,
    //   },
    // });

    //get some entities
    const comments = await io.linear.comments("get-comments", { first: 2 });
    const issues = await io.linear.issues("get-issues", { first: 10 });
    const projects = await io.linear.projects("get-projects", { first: 5 });

    return {
      comments: comments.nodes.length,
      issues: issues.nodes.length,
      projects: projects.nodes.length,
    };
  },
});

createExpressServer(client);
