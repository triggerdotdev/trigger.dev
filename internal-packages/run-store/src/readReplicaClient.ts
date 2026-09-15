// A writer and a read-replica Prisma client are structurally identical at runtime (a replica is a
// `new PrismaClient(...)` too, so it also exposes `$transaction`). The routing layer therefore
// cannot tell a caller-passed replica from a writer by shape, yet it must — a writer/tx read has to
// reach the owning store's PRIMARY (read-your-writes) while a replica read stays on a replica (read
// scaling). So the client builder brands replica handles and the routing store reads the brand.
export const READ_REPLICA_BRAND: unique symbol = Symbol.for("trigger.dev/run-store/read-replica");

// Brand a replica client (returns the same object). MUST only be called on a genuine replica: the
// routing layer trusts the brand to mean "do not escalate this read to the primary". An unbranded
// replica just escalates as before — a scaling miss, never a correctness bug.
export function markReadReplicaClient<T extends object>(client: T): T {
  try {
    (client as Record<symbol, unknown>)[READ_REPLICA_BRAND] = true;
  } catch {
    // Frozen/exotic clients may reject the assignment; only costs the optimization, not correctness.
  }
  return client;
}

export function isReadReplicaClient(client: unknown): boolean {
  return (
    !!client &&
    typeof client === "object" &&
    (client as Record<symbol, unknown>)[READ_REPLICA_BRAND] === true
  );
}
