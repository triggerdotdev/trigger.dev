const PRESENCE_KEY_PREFIX = "dev-presence:connection:";

export class DevPresenceStream {
  static getPresenceKey(environmentId: string) {
    return `${PRESENCE_KEY_PREFIX}${environmentId}`;
  }
}
