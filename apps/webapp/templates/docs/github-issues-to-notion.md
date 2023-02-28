This template contains a [GitHub IssueEvent](https://docs.trigger.dev/integrations/apis/github/events/issues) Trigger that will run whenever an issue action is performed in a GitHub repository. It will then create a new row in a Notion database with details from the GitHub issue.

```ts
import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as notion from "@trigger.dev/notion";

const repo =
  process.env.GITHUB_REPOSITORY ?? "triggerdotdev/github-issues-to-notion";

//todo you can find the database ID in the URL of your Notion database, it's the part after the name
//e.g. https://www.notion.so/triggerdotdev/Notion-test-page-9257302b0758480ebef110889636f107?pvs=4#7953d4fb90724da89d9df4ad68d5e78a
const notionDatabaseId = process.env.NOTION_DATABASE_ID;

new Trigger({
  // Give your Trigger a stable ID
  id: "github-issues-to-notion",
  name: "New GitHub issues are added to your Notion database",
  // This will register a webhook with the repo
  // and trigger whenever a new issue is created or modified
  on: github.events.issueEvent({
    repo,
  }),
  // The run function will get called once per "issue" event
  // See https://docs.trigger.dev/integrations/apis/github/events/issues
  run: async (event, ctx) => {
    if (!notionDatabaseId) {
      throw new Error(
        "Please set the NOTION_DATABASE_ID environment variable to the ID of your Notion database"
      );
    }

    //we only want to act when a new issue is opened
    if (event.action !== "opened") return;

    //a row in a Notion database is added using the createPage API and setting the parent to be the database
    await notion.createPage("📃", {
      parent: {
        database_id: notionDatabaseId,
      },
      properties: {
        //this is the title of the new database row
        title: {
          title: [
            {
              text: {
                content: event.issue.title,
                link: {
                  url: event.issue.html_url,
                },
              },
            },
          ],
        },
      },
      //this goes in the body of the new Notion page (i.e. when you click into it)
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: event.issue.body ?? "No description provided",
                },
              },
            ],
          },
        },
      ],
    });
  },
}).listen();
```

## ✍️ Customize

1. Make sure and update the `repo` parameter to point to a GitHub repository you manage by setting the `GITHUB_REPOSITORY` environment variable.
2. Make sure to set the `NOTION_DATABASE_ID` environment variable to the ID of your Notion database. You can find the database ID in the URL of your Notion database, it's the long number before the question mark

- For this URL https://www.notion.so/triggerdotdev/Notion-test-page-9257302b0758480ebef110889636f107?pvs=4#7953d4fb90724da89d9df4ad68d5e78a
- The database ID is `9257302b0758480ebef110889636f107`

3. Customize the `notion.createPage` call to set properties you want on your Notion database. Note that any properties you set must already exist as columns (in the right format) in the database, otherwise you'll get an error back.

## Extending this example

![Notion database for issues](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/92daa640-6b6e-4ee4-93d8-d36bea295600/public)

This database has 3 extra columns, they must exist in this format:

- Assignees (multi-select)
- Labels (multi-select)
- GitHub (url)

The code below will set the values of these columns based on the GitHub issue.

```ts
import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as notion from "@trigger.dev/notion";

const repo =
  process.env.GITHUB_REPOSITORY ?? "triggerdotdev/github-issues-to-notion";

//todo you can find the database ID in the URL of your Notion database, it's the part after the name
//e.g. https://www.notion.so/triggerdotdev/Notion-test-page-9257302b0758480ebef110889636f107?pvs=4#7953d4fb90724da89d9df4ad68d5e78a
const notionDatabaseId = process.env.NOTION_DATABASE_ID;

new Trigger({
  // Give your Trigger a stable ID
  id: "github-issues-to-notion",
  name: "New GitHub issues are added to your Notion database",
  // This will register a webhook with the repo
  // and trigger whenever a new issue is created or modified
  on: github.events.issueEvent({
    repo,
  }),
  // The run function will get called once per "issue" event
  // See https://docs.trigger.dev/integrations/apis/github/events/issues
  run: async (event, ctx) => {
    if (!notionDatabaseId) {
      throw new Error(
        "Please set the NOTION_DATABASE_ID environment variable to the ID of your Notion database"
      );
    }

    //we only want to act when a new issue is opened
    if (event.action !== "opened") return;

    //a row in a Notion database is added using the createPage API and setting the parent to be the database
    await notion.createPage("📃", {
      parent: {
        database_id: notionDatabaseId,
      },
      properties: {
        //this is the title of the new database row
        title: {
          title: [
            {
              text: {
                content: event.issue.title,
                link: {
                  url: event.issue.html_url,
                },
              },
            },
          ],
        },
        //this is the link to the issue on GitHub
        GitHub: {
          url: event.issue.html_url,
        },
        //the issue assignees as multi-select options
        Assignees: {
          multi_select: event.issue.assignees.map((assignee) => ({
            name: assignee.login,
          })),
        },
        //the issue labels as multi-select options
        Labels: {
          multi_select:
            event.issue.labels?.map((label) => ({
              name: label.name,
            })) ?? [],
        },
      },
      //this goes in the body of the new Notion page (i.e. when you click into it)
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: event.issue.body ?? "No description provided",
                },
              },
            ],
          },
        },
      ],
    });
  },
}).listen();
```
