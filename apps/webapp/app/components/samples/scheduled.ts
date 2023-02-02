export const scheduled = `import { scheduleEvent, Trigger } from "@trigger.dev/sdk";

new Trigger({
  id: "usage",
  name: "usage",
  on: scheduleEvent({ rateof: { minutes: 10 } }),
  run: async (event, ctx) => {
    const { lastRunAt, scheduledTime } = event;

    const query = \`SELECT * FROM users WHERE created_at < \${scheduledTime}\`;

    if (lastRunAt) {
      query += \` AND created_at > \${lastRunAt}\`;
    }

    const latestUsers = await db.query(query);

    // ...
  },
}).listen();`;
