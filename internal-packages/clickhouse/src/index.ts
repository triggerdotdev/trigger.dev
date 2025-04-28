import { ClickHouseSettings } from "@clickhouse/client";
import { ClickhouseClient } from "./client/client.js";
import { ClickhouseReader, ClickhouseWriter } from "./client/types.js";
import { NoopClient } from "./client/noop.js";
import { insertRunEvents } from "./runEvents.js";

export type ClickHouseConfig =
  | {
      name?: string;
      url?: string;
      writerUrl?: never;
      readerUrl?: never;
      clickhouseSettings?: ClickHouseSettings;
    }
  | {
      name?: never;
      url?: never;
      writerName?: string;
      writerUrl: string;
      readerName?: string;
      readerUrl: string;
      clickhouseSettings?: ClickHouseSettings;
    };

export class ClickHouse {
  public readonly reader: ClickhouseReader;
  public readonly writer: ClickhouseWriter;

  constructor(config: ClickHouseConfig) {
    if (config.url) {
      const client = new ClickhouseClient({
        name: config.name ?? "clickhouse",
        url: config.url,
        clickhouseSettings: config.clickhouseSettings,
      });
      this.reader = client;
      this.writer = client;
    } else if (config.writerUrl && config.readerUrl) {
      this.reader = new ClickhouseClient({
        name: config.readerName ?? "clickhouse-reader",
        url: config.readerUrl,
        clickhouseSettings: config.clickhouseSettings,
      });
      this.writer = new ClickhouseClient({
        name: config.writerName ?? "clickhouse-writer",
        url: config.writerUrl,
        clickhouseSettings: config.clickhouseSettings,
      });
    } else {
      this.reader = new NoopClient();
      this.writer = new NoopClient();
    }
  }

  static fromEnv(): ClickHouse {
    if (
      typeof process.env.CLICKHOUSE_WRITER_URL === "string" &&
      typeof process.env.CLICKHOUSE_READER_URL === "string"
    ) {
      return new ClickHouse({
        writerUrl: process.env.CLICKHOUSE_WRITER_URL,
        readerUrl: process.env.CLICKHOUSE_READER_URL,
        writerName: process.env.CLICKHOUSE_WRITER_NAME,
        readerName: process.env.CLICKHOUSE_READER_NAME,
      });
    }

    return new ClickHouse({
      url: process.env.CLICKHOUSE_URL,
      name: process.env.CLICKHOUSE_NAME,
    });
  }

  get runEvents() {
    return {
      insert: insertRunEvents(this.writer),
    };
  }
}
