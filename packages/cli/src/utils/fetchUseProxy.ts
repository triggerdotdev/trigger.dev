import node_fetch, { RequestInfo as _RequestInfo, RequestInit as _RequestInit } from "node-fetch";
import { ProxyAgent } from "proxy-agent";

export type RequestInfo = _RequestInfo;
export type RequestInit = _RequestInit;

export default function fetch(url: RequestInfo, init?: RequestInit) {
	const fetchInit: RequestInit = { ...init };

	// If agent is not specified, specify proxy-agent and use environment variables such as HTTPS_PROXY.
	if (!fetchInit.agent) {
		fetchInit.agent = new ProxyAgent();
	}

	return node_fetch(url, fetchInit);
}
