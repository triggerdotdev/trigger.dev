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
