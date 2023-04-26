import { JobConnection } from ".prisma/client";

export async function allConnectionsReady(
  connections: Array<JobConnection>
): Promise<boolean> {
  if (connections.length === 0) {
    return true;
  }

  const connectionsUsingExternalAuth = connections.filter(
    (connection) => !connection.usesLocalAuth
  );

  if (connectionsUsingExternalAuth.length === 0) {
    return true;
  }

  return connectionsUsingExternalAuth.every((connection) => {
    return connection.apiConnectionId;
  });
}
