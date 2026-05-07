import {
  AbstractStartedContainer,
  GenericContainer,
  StartedTestContainer,
  Wait,
} from "testcontainers";
import { x } from "tinyexec";

const MINIO_PORT = 9000;

export type MinIOConnectionConfig = {
  baseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

export class MinIOContainer extends GenericContainer {
  private accessKeyId = "minioadmin";
  private secretAccessKey = "minioadmin";
  private region = "us-east-1";

  constructor(image = "minio/minio:latest") {
    super(image);
    this.withExposedPorts(MINIO_PORT);
    this.withCommand(["server", "/data"]);
    this.withWaitStrategy(Wait.forLogMessage(/API:/));
    this.withStartupTimeout(120_000);
  }

  public withAccessKeyId(accessKeyId: string): this {
    this.accessKeyId = accessKeyId;
    return this;
  }

  public withSecretAccessKey(secretAccessKey: string): this {
    this.secretAccessKey = secretAccessKey;
    return this;
  }

  public withRegion(region: string): this {
    this.region = region;
    return this;
  }

  public override async start(): Promise<StartedMinIOContainer> {
    this.withEnvironment({
      MINIO_ROOT_USER: this.accessKeyId,
      MINIO_ROOT_PASSWORD: this.secretAccessKey,
    });

    const startedContainer = await super.start();

    // Create the "packets" bucket using MinIO client
    await x(
      "docker",
      [
        "exec",
        startedContainer.getId(),
        "mc",
        "alias",
        "set",
        "local",
        "http://localhost:9000",
        this.accessKeyId,
        this.secretAccessKey,
      ],
      { throwOnError: true }
    );

    await x(
      "docker",
      ["exec", startedContainer.getId(), "mc", "mb", "local/packets"],
      { throwOnError: true }
    );

    return new StartedMinIOContainer(
      startedContainer,
      this.accessKeyId,
      this.secretAccessKey,
      this.region
    );
  }
}

export class StartedMinIOContainer extends AbstractStartedContainer {
  constructor(
    startedTestContainer: StartedTestContainer,
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    private readonly region: string
  ) {
    super(startedTestContainer);
  }

  public getPort(): number {
    return super.getMappedPort(MINIO_PORT);
  }

  public getAccessKeyId(): string {
    return this.accessKeyId;
  }

  public getSecretAccessKey(): string {
    return this.secretAccessKey;
  }

  public getRegion(): string {
    return this.region;
  }

  /**
   * Gets the base URL (protocol, host and mapped port) for the MinIO container.
   * Example: `http://localhost:32768`
   */
  public getBaseUrl(): string {
    const protocol = "http";
    const host = this.getHost();
    const port = this.getPort();
    return `${protocol}://${host}:${port}`;
  }

  /**
   * Gets connection configuration suitable for object storage clients.
   */
  public getConnectionConfig(): MinIOConnectionConfig {
    return {
      baseUrl: this.getBaseUrl(),
      accessKeyId: this.getAccessKeyId(),
      secretAccessKey: this.getSecretAccessKey(),
      region: this.getRegion(),
    };
  }
}
