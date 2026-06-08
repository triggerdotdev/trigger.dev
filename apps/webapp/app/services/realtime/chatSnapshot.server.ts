import { env } from "~/env.server";

/**
 * Canonical storage URI for a session's chat.agent snapshot. Stamped on
 * `Session.chatSnapshotStoragePath` at row creation so PUT/GET presigns
 * resolve to the same store even if `OBJECT_STORE_DEFAULT_PROTOCOL`
 * changes later.
 */
export function chatSnapshotStoragePathForSession(friendlyId: string): string {
  const path = `sessions/${friendlyId}/snapshot.json`;
  const protocol = env.OBJECT_STORE_DEFAULT_PROTOCOL;
  return protocol ? `${protocol}://${path}` : path;
}

/**
 * Resolve the storage key/URI a session's chat snapshot is written to and read
 * from. Single source of truth shared by every reader/writer so they all hit
 * the same object store:
 * - the SDK write + boot read (via the `snapshot-url` presign route), and
 * - the dashboard `SessionPresenter` (Agent/Session view).
 *
 * Prefers `chatSnapshotStoragePath` stamped at row creation (already
 * protocol-qualified, e.g. `s3://sessions/{id}/snapshot.json`), falling back to
 * recomputing it for sessions created before the column existed. Using a bare,
 * unqualified key here is the bug this guards against: the object store applies
 * `OBJECT_STORE_DEFAULT_PROTOCOL` to unprefixed keys on PUT but not on GET, so a
 * bare key can write to one store and read from another.
 */
export function chatSnapshotStorageKey(session: {
  friendlyId: string;
  chatSnapshotStoragePath: string | null;
}): string {
  return session.chatSnapshotStoragePath ?? chatSnapshotStoragePathForSession(session.friendlyId);
}
