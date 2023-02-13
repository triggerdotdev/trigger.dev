import { makeEndpoints } from "core/endpoint/endpoint";
import { authentication } from "../authentication";
import * as specs from "./specs";

const baseUrl = "https://slack.com/api";

const endpoints = makeEndpoints(baseUrl, authentication, specs);
export default endpoints;
