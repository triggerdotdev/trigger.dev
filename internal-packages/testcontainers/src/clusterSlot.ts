// CRC16/XMODEM over a key's hash tag, computed here because CLUSTER KEYSLOT is unavailable on a
// standalone test container. Pinned against the cluster-key-slot package for our key shapes.

function crc16(str: string): number {
  let crc = 0;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/** The Redis cluster slot (0–16383) for a key, honouring `{…}` hash-tag extraction. */
export function slotOf(key: string): number {
  const start = key.indexOf("{");
  const end = start === -1 ? -1 : key.indexOf("}", start + 1);
  const tag = start !== -1 && end !== -1 && end > start + 1 ? key.slice(start + 1, end) : key;
  return crc16(tag) % 16384;
}

/** Throws unless every key maps to one slot. A `[]` or single-key input passes. */
export function expectOneSlot(keys: string[]): void {
  if (keys.length <= 1) return;
  const slots = new Set(keys.map(slotOf));
  if (slots.size !== 1) {
    throw new Error(
      `expected all keys in one cluster slot, got ${slots.size}: ${JSON.stringify(keys)}`
    );
  }
}
