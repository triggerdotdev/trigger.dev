import type { HelpSample, Integration } from "../types";

function usageSample(hasApiKey: boolean): HelpSample {
  return {
    title: "Using the client",
    code: `
  import { Airtable } from "@trigger.dev/airtable";

  const airtable = new Airtable({
    id: "__SLUG__"${hasApiKey ? ",\n    token: process.env.AIRTABLE_API_KEY!" : ""}
  });

  client.defineJob({
    id: "alert-on-new-github-issues",
    name: "Alert on new GitHub issues",
    version: "0.1.1",
    trigger: github.triggers.repo({
      event: events.onIssueOpened,
      owner: "triggerdotdev",
      repo: "trigger.dev",
    }),
    run: async (payload, io, ctx) => {
      //wrap the SDK call in runTask
      const { data } = await io.runTask(
        "create-card",
        { name: "Create card" },
        async () => {
          //create a project card using the underlying client
          return io.github.client.rest.projects.createCard({
            column_id: 123,
            note: "test",
          });
        }
      );
  
      //log the url of the created card
      await io.logger.info(data.url);
    },
  });
  
  `,
  };
}

export const airtable: Integration = {
  identifier: "airtable",
  name: "Airtable",
  packageName: "@trigger.dev/airtable",
  authenticationMethods: {
    oauth2: {
      name: "OAuth2",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_AIRTABLE_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_AIRTABLE_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://airtable.com/oauth2/v1/authorize",
          scopeSeparator: " ",
          authorizationLocation: "header",
          extraParameters: {
            response_type: "code",
          },
        },
        token: {
          url: "https://airtable.com/oauth2/v1/token",
          metadata: {},
        },
        refresh: {
          url: "https://airtable.com/oauth2/v1/token",
        },
      },
      scopes: [
        {
          name: "data.records:read",
          description: "See the data in records",
          defaultChecked: true,
        },
        {
          name: "data.records:write",
          description: "Create, edit, and delete records",
          defaultChecked: true,
        },
        {
          name: "data.recordComments:read",
          description: "See comments in records",
          defaultChecked: true,
        },
        {
          name: "data.recordComments:write",
          description: "Create, edit, and delete record comments",
          defaultChecked: true,
        },
        {
          name: "schema.bases:read",
          description: "See the structure of a base, like table names or field types",
        },
        {
          name: "schema.bases:write",
          description: "Edit the structure of a base, like adding new fields or tables",
        },
        {
          name: "webhook:manage",
          description:
            "View, create, delete webhooks for a base, as well as fetch webhook payloads.",
          defaultChecked: true,
        },
      ],
      help: {
        samples: [usageSample(false)],
      },
    },
    apiKey: {
      type: "apikey",
      help: {
        samples: [usageSample(true)],
      },
    },
  },
};
