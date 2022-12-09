import Pulsar from "pulsar-client";

export const pulsarClient = new Pulsar.Client({
  serviceUrl: process.env.PULSAR_URL ?? "pulsar://localhost:6650",
});
