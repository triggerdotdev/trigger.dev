export type PrismaConnectionParams = {
  connectionLimit: string;
  poolTimeout: string;
  connectTimeout: string;
  applicationName: string;
};

export function buildPrismaConnectionUrl(
  baseUrl: string | URL,
  params: PrismaConnectionParams
): URL {
  const url = new URL(baseUrl);
  url.searchParams.set("connection_limit", params.connectionLimit);
  url.searchParams.set("pool_timeout", params.poolTimeout);
  url.searchParams.set("connect_timeout", params.connectTimeout);
  url.searchParams.set("application_name", params.applicationName);
  return url;
}
