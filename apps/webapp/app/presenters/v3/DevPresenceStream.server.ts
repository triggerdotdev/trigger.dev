const PRESENCE_KEY_PREFIX = "dev-presence:connection:";
const PRESENCE_CHANNEL_PREFIX = "dev-presence:updates:";

export class DevPresenceStream {
  static getPresenceKey(environmentId: string) {
    return `${PRESENCE_KEY_PREFIX}${environmentId}`;
  }

  static getPresenceChannel(environmentId: string) {
    return `${PRESENCE_CHANNEL_PREFIX}${environmentId}`;
  }
}
