import { Pool, QueryResultRow } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query<TQueryResult extends QueryResultRow>(
  text: string,
  params?: any[]
) {
  return pool.query<TQueryResult>(text, params);
}

export async function getTableCount(
  tableName: string,
  startAt: Date,
  endAt: Date
) {
  const tableCount = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM "${tableName}" WHERE "${tableName}"."createdAt" >= $1 AND "${tableName}"."createdAt" < $2`,
    [startAt, endAt]
  ).then((result) => parseInt(result.rows[0].count, 10));

  return tableCount;
}

export async function getClient() {
  const client = await pool.connect();
  const query = client.query;
  const release = client.release;
  // set a timeout of 5 seconds, after which we will log this client's last query
  const timeout = setTimeout(() => {
    console.error("A client has been checked out for more than 5 seconds!");
  }, 5000);

  client.release = () => {
    // clear our timeout
    clearTimeout(timeout);
    // set the methods back to their old un-monkey-patched version
    client.query = query;
    client.release = release;
    return release.apply(client);
  };
  return client;
}
