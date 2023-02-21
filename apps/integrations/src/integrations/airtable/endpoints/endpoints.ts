import { makeEndpoints } from "core/endpoint/endpoint";
import { authentication } from "../authentication";
import * as specs from "./specs";

const baseUrl = "https://api.airtable.com/v0";

const endpoints = makeEndpoints(baseUrl, authentication, specs);
export default endpoints;
