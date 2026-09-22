# Webhook engine setup

Application queries use `WEBHOOK_DATABASE_URL`, or the application database when unset. To use a
pooled app connection with separate credentials for partition DDL, configure both URLs:

| Variable | Purpose |
| --- | --- |
| `WEBHOOK_DATABASE_URL` | Application reads and writes, such as a pooled connection on port 6432 with a data-access role. |
| `WEBHOOK_DATABASE_DIRECT_URL` | Bootstrap and daily partition creation/retention, such as a direct connection on port 5432 with an object-owner role. |

Both URLs must target the same database. The direct client uses a single-connection pool. Its role
must own the partitioned parent and children and have CREATE permission on their schema. Using the
same owner role for schema migrations and partition maintenance satisfies that ownership requirement;
grant the app role data access separately. Configure the direct URL on services that serve the admin
bootstrap route or run partition maintenance. When unset, partition operations reuse the webhook
writer connection, preserving existing installations.

Schema migrations remain explicit: run the shared `@trigger.dev/database` Prisma migration history
with `DATABASE_URL` and `DIRECT_URL` set to the direct webhook connection in the migration process.
Setting `WEBHOOK_DATABASE_DIRECT_URL` on the app does not run migrations or override the app's
control-plane connection.

Before enabling webhooks on a new installation or webhook database:

1. Apply the webhook schema to the database used by `webhookPrisma` (`WEBHOOK_DATABASE_URL` when set,
   otherwise the application database).
2. With webhooks still disabled, call the bootstrap endpoint using an admin personal access token:

   ```sh
   curl --fail-with-body -X POST "$API_ORIGIN/admin/api/v1/webhooks/partitions/bootstrap" \
     -H "Authorization: Bearer $ADMIN_PAT"
   ```

3. After the call succeeds, enable `WEBHOOK_ENABLED=1` and the webhook worker. The daily maintenance
   job then creates future partitions and removes expired ones.

Bootstrap creates the configured UTC partition window (defaults: 60 days back, 10 days ahead).
It is safe to repeat and does not delete data. Repeat before enabling if the lookahead window has
expired, or after switching webhook databases. A conflicting table or incorrect partition bound
causes the call to fail so it cannot report an incomplete window as ready.

Enabling ingress without bootstrap can cause delivery inserts to fail until the first maintenance
run. Bootstrap prepares dated partitions only; it does not install the webhook schema.
