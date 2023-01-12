import Pulsar, {
  AuthenticationOauth2,
  AuthenticationToken,
} from "pulsar-client";

export type ClientOptions = {
  serviceUrl?: string;
  token?: string;
  operationTimeoutSeconds?: number;
  ioThreads?: number;
  messageListenerThreads?: number;
  concurrentLookupRequest?: number;
  useTls?: boolean;
  tlsTrustCertsFilePath?: string;
  tlsValidateHostname?: boolean;
  tlsAllowInsecureConnection?: boolean;
  statsIntervalInSeconds?: number;
};

export { Pulsar };

export type PulsarMessage = Pulsar.Message;
export type PulsarProducer = Pulsar.Producer;
export type PulsarConsumer = Pulsar.Consumer;
export type PulsarClient = Pulsar.Client;
export type PulsarProducerConfig = Pulsar.ProducerConfig;
export type PulsarConsumerConfig = Pulsar.ConsumerConfig;

function createPulsarClient(options?: ClientOptions): PulsarClient {
  const opts = options || {};

  const serviceUrl =
    opts.serviceUrl ||
    process.env.PULSAR_SERVICE_URL ||
    "pulsar://localhost:6650";

  const authentication = opts.token
    ? new AuthenticationToken({ token: opts.token })
    : oauth2AuthenticationFromEnv();

  if (process.env.PULSAR_DEBUG) {
    Pulsar.Client.setLogHandler((level, file, line, message) => {
      console.log("[%s][%s:%d] %s", level, file, line, message);
    });
  }

  console.log(`Connecting to pulsar instance at ${serviceUrl}...`);

  return new Pulsar.Client({
    ...opts,
    serviceUrl,
    authentication,
  });
}

function oauth2AuthenticationFromEnv(): AuthenticationOauth2 | undefined {
  const clientId = process.env.PULSAR_CLIENT_ID;
  const clientSecret = process.env.PULSAR_CLIENT_SECRET;
  const issuerUrl = process.env.PULSAR_ISSUER_URL;
  const audience = process.env.PULSAR_AUDIENCE;

  if (!clientId || !clientSecret || !issuerUrl || !audience) {
    return undefined;
  }

  return new AuthenticationOauth2({
    type: "sn_service_account",
    client_id: clientId,
    client_secret: clientSecret,
    issuer_url: issuerUrl,
    audience,
  });
}

const TENANT = process.env.PULSAR_TENANT || "public";
const WORKFLOWS_NAMESPACE = process.env.PULSAR_WORKFLOWS_NAMESPACE || "default";
const QUEUES_NAMESPACE = process.env.PULSAR_QUEUES_NAMESPACE || "default";

export const Topics = {
  triggers: `persistent://${TENANT}/${WORKFLOWS_NAMESPACE}/triggers`,
  runCommands: `persistent://${TENANT}/${WORKFLOWS_NAMESPACE}/run-commands`,
  runCommandResponses: `persistent://${TENANT}/${WORKFLOWS_NAMESPACE}/run-command-responses`,
  integrationWorker: `persistent://${TENANT}/${QUEUES_NAMESPACE}/integration-requests`,
  appTaskWorker: `persistent://${TENANT}/${QUEUES_NAMESPACE}/background-tasks`,
};

export const pulsarClient = createPulsarClient();
