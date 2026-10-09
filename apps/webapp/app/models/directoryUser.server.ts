import { Prisma, type PrismaClient } from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/utils";

type DirectoryUserParams = {
  email: string;
  firstName: string | null;
  lastName: string | null;
};

// Matches on the lowercased email. New rows are marked SSO since the user will
// authenticate via the org's IdP.
export async function findOrCreateDirectoryUser(
  client: PrismaClient,
  params: DirectoryUserParams
): Promise<{ userId: string }> {
  const email = params.email.toLowerCase().trim();
  const existingId = await findUserIdByEmail(client, email);
  if (existingId) return { userId: existingId };

  const name = [params.firstName, params.lastName].filter(Boolean).join(" ").trim() || null;
  const [error, created] = await tryCatch(
    client.user.create({
      data: { email, authenticationMethod: "SSO", name, displayName: name },
      select: { id: true },
    })
  );
  if (!error) return { userId: created.id };

  // Concurrent directory events for one email race on create; the loser reuses
  // the winner's row.
  const isUniqueViolation =
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  if (!isUniqueViolation) throw error;

  const winnerId = await findUserIdByEmail(client, email);
  if (!winnerId) throw error;
  return { userId: winnerId };
}

// Same rule as SSO login: an exact match on the lowercased email (unique
// index) wins, otherwise a single case-insensitive match. That fallback scans
// User, which is fine for this rare first-contact lookup. Several casings
// without an exact match are ambiguous, so nothing matches.
async function findUserIdByEmail(client: PrismaClient, email: string): Promise<string | null> {
  const exact = await client.user.findFirst({ where: { email }, select: { id: true } });
  if (exact) return exact.id;

  const folded = await client.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE lower("email") = ${email} LIMIT 2
  `;
  if (folded.length !== 1) return null;
  return folded[0].id;
}
