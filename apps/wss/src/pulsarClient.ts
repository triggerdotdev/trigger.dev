import Pulsar from "pulsar-client";
import { env } from "./env";

export const pulsarClient = new Pulsar.Client({
  serviceUrl: env.PULSAR_URL,
});
