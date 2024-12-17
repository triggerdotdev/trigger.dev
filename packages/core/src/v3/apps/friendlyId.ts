import { customAlphabet } from "nanoid";
import cuid from "@bugsnag/cuid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export function generateFriendlyId(prefix: string, size?: number) {
  return `${prefix}_${idGenerator(size)}`;
}

export function generateInternalId() {
  return cuid();
}

/** Convert an internal ID to a friendly ID */
export function toFriendlyId(entityName: string, internalId: string): string {
  if (!entityName) {
    throw new Error("Entity name cannot be empty");
  }

  if (!internalId) {
    throw new Error("Internal ID cannot be empty");
  }

  return `${entityName}_${internalId}`;
}

/** Convert a friendly ID to an internal ID */
export function fromFriendlyId(friendlyId: string, expectedEntityName?: string): string {
  if (!friendlyId) {
    throw new Error("Friendly ID cannot be empty");
  }

  const parts = friendlyId.split("_");

  if (parts.length !== 2) {
    throw new Error("Invalid friendly ID format");
  }

  const [entityName, internalId] = parts;

  if (!entityName) {
    throw new Error("Entity name cannot be empty");
  }

  if (!internalId) {
    throw new Error("Internal ID cannot be empty");
  }

  if (expectedEntityName && entityName !== expectedEntityName) {
    throw new Error(`Invalid entity name: ${entityName}`);
  }

  return internalId;
}

export class IdUtil {
  constructor(private entityName: string) {}

  generate() {
    const internalId = generateInternalId();

    return {
      id: internalId,
      friendlyId: this.toFriendlyId(internalId),
    };
  }

  toFriendlyId(internalId: string) {
    return toFriendlyId(this.entityName, internalId);
  }

  fromFriendlyId(friendlyId: string) {
    return fromFriendlyId(friendlyId);
  }
}

export const BackgroundWorkerId = new IdUtil("worker");
export const CheckpointId = new IdUtil("checkpoint");
export const QueueId = new IdUtil("queue");
export const RunId = new IdUtil("run");
export const SnapshotId = new IdUtil("snapshot");
export const WaitpointId = new IdUtil("waitpoint");
