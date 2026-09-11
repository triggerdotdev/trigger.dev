// What to do when a replication client has exhausted its in-process
// self-healing. The client retries a lost stream or leader lock on its own with
// backoff; once it gives up, the stream is not coming back without help (a
// dropped slot, a publication that no longer exists, credentials that no longer
// work). Retrying past that point hides a dead replica behind a healthy-looking
// process.
//
// Exiting hands the problem to whatever supervises us (Kubernetes, ECS,
// systemd), which can give the process a clean slate. Deployments without a
// supervisor leave *_REPLICATION_MAX_RESUBSCRIBE_ATTEMPTS at 0, so the client
// never gives up and this never runs.
//
// The process-control decision lives here, at the composition root, rather than
// inside the replication services: they take an `onUnrecoverable` callback so
// they stay testable without touching globals.

// One exit, however many sources give up. The first failure is the useful one;
// the rest would only race the same timer.
let exitScheduled = false;

export function scheduleReplicationExit(options: {
  label: string;
  delayMs: number;
  exitCode: number;
  details: Record<string, unknown>;
}): void {
  const { label, delayMs, exitCode, details } = options;

  if (exitScheduled) return;
  exitScheduled = true;

  console.error(
    `🗃️ ${label}: replication is unrecoverable, exiting in ${delayMs}ms so the supervisor can restart this process`,
    { ...details, exitCode }
  );

  // Delayed so the logs above can flush; unref'd so this timer alone never
  // keeps an otherwise-finished process alive.
  setTimeout(() => process.exit(exitCode), delayMs).unref();
}
