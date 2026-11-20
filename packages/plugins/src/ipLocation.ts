/** Approximate location of an IP address: its country and the network (AS) that announces it. */
export type IpLocation = {
  country: string | null;
  countryCode: string | null;
  asn: number | null;
  asName: string | null;
};

/** Looks up an IP's location. Resolves `undefined` when it's unknown. Must not throw. */
export type IpLocationLookup = (ip: string) => Promise<IpLocation | undefined>;
