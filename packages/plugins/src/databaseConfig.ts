// Database connections for a plugin that owns its own client. The host
// resolves the URLs from its env so the plugin follows the same
// writer/replica topology the host uses. Shared by every plugin contract
// that carries a `database` section.
export type PluginDatabaseConfig = {
  // Primary (writer) connection URL. Mutations and read-your-writes
  // management reads run here.
  writerUrl: string;
  // Read-replica URL for the per-request auth reads. Omitted → those reads
  // share the writer connection.
  readerUrl?: string;
  // Per-process pool sizes. Omitted → plugin defaults (writer 2, reader 5).
  writerConnectionLimit?: number;
  readerConnectionLimit?: number;
};
