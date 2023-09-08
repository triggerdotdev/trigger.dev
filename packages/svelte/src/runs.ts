import { createQuery, type CreateQueryResult } from '@tanstack/svelte-query';
import {
	GetRunSchema,
	urlWithSearchParams,
	type GetRun,
	type GetRunOptions
} from '@trigger.dev/core';
import { getTriggerContext } from './providerContext.js';
import { zodfetch } from './fetch.js';

export const runResolvedStatuses = ['SUCCESS', 'FAILURE', 'CANCELED', 'TIMED_OUT', 'ABORTED'];

const defaultRefreshInterval = 1000;

export type RunDetailOptions = GetRunOptions & {
	/** How often you want to refresh, the default is 1000. Min is 500  */
	refreshIntervalMs?: number;
};

export type UseRunDetailsResult = CreateQueryResult<GetRun>;

export function useRunDetails(
	runId: string | undefined,
	options?: RunDetailOptions
): UseRunDetailsResult {
	const { apiUrl, publicApiKey } = getTriggerContext();

	const { refreshIntervalMs: refreshInterval, ...otherOptions } = options || {};

	const url = urlWithSearchParams(`${apiUrl}/api/v1/runs/${runId}`, otherOptions);

	return createQuery({
		queryKey: [`triggerdotdev-run-${runId}`],
		queryFn: async () => {
			return await zodfetch(GetRunSchema, url, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${publicApiKey}`
				}
			});
		},
		enabled: !!runId,
		refetchInterval: (data) => {
			if (data?.status && runResolvedStatuses.includes(data.status)) {
				return false;
			}
			if (refreshInterval !== undefined) {
				return Math.max(refreshInterval, 500);
			}

			return defaultRefreshInterval;
		}
	});
}
