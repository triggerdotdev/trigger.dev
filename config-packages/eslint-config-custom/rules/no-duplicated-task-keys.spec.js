"use strict";

const RuleTester = require('eslint').RuleTester;
const rule = require('./no-duplicated-task-keys');
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
  ]
});