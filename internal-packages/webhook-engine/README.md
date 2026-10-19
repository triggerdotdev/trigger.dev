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

Bootstrap creates, for every retention class (3, 7, 30, 90, 180 and 365 days), the class's
sub-partition and its UTC leaves from today through the lookahead (`WEBHOOK_PARTITION_LOOKAHEAD_DAYS`,
default 10). Classes up to 30 days use day leaves and longer ones week leaves. It never creates past
leaves, since ingest only writes the current time. It is safe to repeat and does not delete data.
Repeat before enabling if the lookahead window has expired, or after switching webhook databases. A
conflicting table or incorrect partition bound causes the call to fail so it cannot report an
incomplete window as ready.

Enabling ingress without bootstrap can cause delivery inserts to fail until the first maintenance
run. Bootstrap prepares partitions only; it does not install the webhook schema.

## Delivery retention

Each delivery is stored in one retention class, stamped when it is written and encoded in its id.
The daily maintenance job drops a class's leaf once its whole range is older than the class. An
org's visible retention (`deliveryRetentionDays` in its webhook limits, default
`WEBHOOK_DELIVERY_RETENTION_DAYS`) is enforced when reading. Deliveries are stored for at least
`WEBHOOK_DELIVERY_STORAGE_DAYS` (default 30), or the org's retention rounded up to a class when it
is longer or when the org sets `deliveryRetentionStrict`.
