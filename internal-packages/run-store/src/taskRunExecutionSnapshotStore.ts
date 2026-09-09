import { DelegatingRunStore } from "./delegatingRunStore.js";

/**
 * Postgres pass-through. This layer introduces the MemoryDB storage and durability primitives only;
 * nothing constructs or uses this decorator yet. Every RunStore method delegates through
 * DelegatingRunStore, so run behaviour is identical to the undecorated Postgres store. The full
 * capture/read decorator behaviour lands in a later change.
 */
export class TaskRunExecutionSnapshotStore extends DelegatingRunStore {}
