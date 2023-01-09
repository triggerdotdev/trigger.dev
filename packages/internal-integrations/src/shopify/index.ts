import debug from "debug";
import {
  DisplayProperties,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
} from "../types";

const log = debug("trigger:integrations:slack");

// class ShopifyRequestIntegration implements RequestIntegration {
//   constructor(private readonly baseUrl: string = "https://slack.com/api") {}

//   perform: (options: PerformRequestOptions) => Promise<PerformedRequestResponse>;
//   displayProperties: (endpoint: string, params: any) => DisplayProperties;
// }

// export const requests = new ShopifyRequestIntegration();
