// Deterministic one-shot connection-blip injection for the store's infra-retry tests. Rather than race
// a live socket sever (which flakes on CI when the query finishes before the sever lands), wrap a Prisma
// client so exactly one call to `model.operation` is hit by a connection loss, then passes through to
// the real query on a real testcontainer DB.

// The literal message node-postgres throws when a connection dies mid-statement. The infra classifier
// recognises it (proven in database/src/infraError.test.ts), so injecting it exercises the store's retry
// wiring against the REAL classifier.
function connectionLost(): Error {
  return new Error("Connection terminated unexpectedly");
}

//   phase "before" — the loss lands before the statement runs (a connection lost pre-commit); the retry
//                    re-issues and commits.
//   phase "after"  — the statement commits, then its acknowledgement is lost (the dangerous case); the
//                    retry REPLAYS against already-committed state, which must be idempotent.
export function withOneShotBlip<T extends object>(
  prisma: T,
  model: string,
  operation: string,
  phase: "before" | "after" = "before"
): T {
  let fired = false;
  return (prisma as any).$extends({
    query: {
      [model]: {
        async [operation]({
          args,
          query,
        }: {
          args: unknown;
          query: (a: unknown) => Promise<unknown>;
        }) {
          if (phase === "before") {
            if (!fired) {
              fired = true;
              throw connectionLost();
            }
            return query(args);
          }
          const result = await query(args);
          if (!fired) {
            fired = true;
            throw connectionLost();
          }
          return result;
        },
      },
    },
  }) as T;
}
