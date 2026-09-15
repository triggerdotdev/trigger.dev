import type { StartedTestContainer } from "testcontainers";
import { AbstractStartedContainer, GenericContainer, Wait } from "testcontainers";

const OTLP_HTTP_PORT = 4318;
const CONFIG_PATH = "/etc/otelcol-config.yaml";

const CONFIG = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:${OTLP_HTTP_PORT}
exporters:
  debug: {}
service:
  telemetry:
    logs:
      level: WARN
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
`;

export class OtelCollectorContainer extends GenericContainer {
  constructor(
    image = "otel/opentelemetry-collector-k8s:0.158.0@sha256:c09130a633196a5becee164411473a0932ecf223f94fda6dab5f22798ff9f376"
  ) {
    super(image);
    this.withExposedPorts(OTLP_HTTP_PORT);
    this.withCopyContentToContainer([{ content: CONFIG, target: CONFIG_PATH }]);
    this.withCommand([`--config=${CONFIG_PATH}`]);
    this.withWaitStrategy(Wait.forHttp("/v1/metrics", OTLP_HTTP_PORT).forStatusCode(405));
    this.withStartupTimeout(120_000);
  }

  public override async start(): Promise<StartedOtelCollectorContainer> {
    return new StartedOtelCollectorContainer(await super.start());
  }
}

export class StartedOtelCollectorContainer extends AbstractStartedContainer {
  constructor(startedTestContainer: StartedTestContainer) {
    super(startedTestContainer);
  }

  public getPort(): number {
    return super.getMappedPort(OTLP_HTTP_PORT);
  }

  /**
   * Base URL for OTLP/HTTP, without a signal path.
   * Example: `http://localhost:32768`
   */
  public getOtlpHttpUrl(): string {
    return `http://${this.getHost()}:${this.getPort()}`;
  }
}
