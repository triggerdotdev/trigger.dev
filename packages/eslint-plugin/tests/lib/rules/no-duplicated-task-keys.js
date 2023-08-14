/**
 * @fileoverview Prevent duplicated task keys on trigger.dev jobs
 * @author 
 */
"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const rule = require("../../../lib/rules/no-duplicated-task-keys"),
  RuleTester = require("eslint").RuleTester;


//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

const ruleTester = new RuleTester({
  parserOptions: {
    sourceType: "module",
    ecmaVersion: 2020,
  }
});
ruleTester.run("no-duplicated-task-keys", rule, {
  valid: [
    {
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.runTask("task", { name: "My Task" }, async () => {});
        }
      })`
    },
    {
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.stripe.createCharge("charge", {})
        }
      })`
    },
    {
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.supabase.createProject("create-project", {})
        }
      })`
    },
    {
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.typeform.listForms("list-forms");
        }
      })`
    },
  ],

  invalid: [
    { 
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.runTask("duplicated-task", { name: "My Task" }, async () => {
            return await longRunningCode(payload.userId);
          });

          await io.runTask("duplicated-task", { name: "My Task" }, async () => {
            return await longRunningCode(payload.userId);
          });
        }
      })`,
      errors: [{ message: "Task key 'duplicated-task' is duplicated" }]
    },
    { 
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.stripe.createCharge("duplicated-charge", {
            amount: 100,
            currency: "usd",
            source: payload.source,
            customer: payload.customerId,
          });
          await io.stripe.createCharge("duplicated-charge", {
            amount: 100,
            currency: "usd",
            source: payload.source,
            customer: payload.customerId,
          });
        }
      })`,
      errors: [{ message: "Task key 'duplicated-charge' is duplicated" }]
    },
    { 
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.supabase.createProject("create-project", {
            name: payload.name,
            organization_id: payload.organization_id,
            plan: payload.plan,
            region: payload.region,
            kps_enabled: true,
            db_pass: payload.password,
          })
          await io.supabase.createProject("create-project", {
            name: payload.name,
            organization_id: payload.organization_id,
            plan: payload.plan,
            region: payload.region,
            kps_enabled: true,
            db_pass: payload.password,
          })
        }
      });`,
      errors: [{ message: "Task key 'create-project' is duplicated" }]
    },
    { 
      code: `client.defineJob({
        run: async (payload, io, ctx) => {
          await io.typeform.listForms("list-forms");

          await io.typeform.listForms("list-forms");
        }
      })`,
      errors: [{ message: "Task key 'list-forms' is duplicated" }]
    },
    {
      code: `client.defineJob({
        id: "github-integration-on-issue-opened",
        name: "GitHub Integration - On Issue Opened",
        version: "0.1.0",
        integrations: { github: githubApiKey },
        trigger: githubApiKey.triggers.repo({
          event: events.onIssueOpened,
          owner: "triggerdotdev",
          repo: "empty",
        }),
        run: async (payload, io, ctx) => {
          await io.github.addIssueAssignees("add assignee", {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            issueNumber: payload.issue.number,
            assignees: ["matt-aitken"],
          });
      
          await io.github.addIssueAssignees("add assignee", {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            issueNumber: payload.issue.number,
            assignees: ["matt-aitken"],
          });
      
          await io.github.addIssueLabels("add label", {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            issueNumber: payload.issue.number,
            labels: ["bug"],
          });
      
          return { payload, ctx };
        },
      })`,
      errors: [
        { message: "Task key 'add assignee' is duplicated" },
      ]
    },
    {
      code: `client.defineJob({
        id: "react-hook",
        name: "React Hook test",
        version: "0.0.1",
        trigger: eventTrigger({
          name: "react-hook",
        }),
        integrations: {
          openai,
        },
        run: async (_payload, io) => {
          await io.wait("Wait 2 seconds", 2);
          await io.wait("Wait 1 second", 1);
          await io.wait("Wait 1 second", 1);
      
          await io.openai.backgroundCreateChatCompletion("Tell me a joke", {
            model: "gpt-3.5-turbo-16k",
            messages: [
              {
                role: "user",
                content: 'Tell me a joke please',
              },
            ],
          });
          const result = await io.openai.backgroundCreateChatCompletion("Tell me a joke", {
            model: "gpt-3.5-turbo-16k",
            messages: [
              {
                role: "user",
                content: 'Tell me a joke please',
              },
            ],
          });
      
          return {
            summary: result?.choices[0]?.message?.content,
          };
        },
      });`,
      errors: [
        { message: "Task key 'Tell me a joke' is duplicated" },
        { message: "Task key 'Wait 1 second' is duplicated" },
      ]
    }
  ]
});
