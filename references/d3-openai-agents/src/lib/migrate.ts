import { sql } from "@vercel/postgres";

export async function migrate(direction: "up" | "down") {
  if (direction === "up") {
    await migrateUp();
  } else {
    await migrateDown();
  }
}

export async function migrateUp() {
  const createTable = await sql`
    CREATE TABLE IF NOT EXISTS todos (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 3,
      due_date TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP WITH TIME ZONE,
      tags TEXT[], -- Array of tags
      assigned_to VARCHAR(255)
    );
  `;

  console.log(`Created "todos" table`);

  return {
    createTable,
  };
}

export async function migrateDown() {
  const dropTable = await sql`
    DROP TABLE IF EXISTS todos;
  `;

  console.log(`Dropped "todos" table`);
}

async function main() {
  const direction = process.argv[2];
  await migrate(direction as "up" | "down");
}

main().catch(console.error);
