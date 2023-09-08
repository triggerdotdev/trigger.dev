import { createQuery, type CreateQueryResult } from '@tanstack/svelte-query';
import { GetEventSchema, type GetEvent } from '@trigger.dev/core';
import { getTriggerContext } from './providerContext.js';
import { zodfetch } from './fetch.js';
import {
	type RunDetailOptions,
	runResolvedStatuses,
	useRunDetails,
	type UseRunDetailsResult
} from './runs.js';
import { onDestroy } from 'svelte';

const defaultRefreshInterval = 1000;

export type UseEventDetailsResult = CreateQueryResult<GetEvent>;
export function useEventDetails(eventId: string | undefined): UseEventDetailsResult {
	const { apiUrl, publicApiKey } = getTriggerContext();

	return createQuery({
		queryKey: [`triggerdotdev-event-${eventId}`],
		queryFn: async () => {
			return await zodfetch(GetEventSchema, `${apiUrl}/api/v1/events/${eventId}`, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${publicApiKey}`
				}
			});
		},
		refetchInterval: (data) => {
			if (
				data &&
				data.runs.length > 0 &&
				data.runs.every((r) => runResolvedStatuses.includes(r.status))
			) {
				return false;
			}

			return defaultRefreshInterval;
		},
		enabled: !!eventId
	});
}

export function useEventRunDetails(
	eventId: string | undefined,
	options?: RunDetailOptions
): UseRunDetailsResult {
	const event = useEventDetails(eventId);
	let result: UseRunDetailsResult;
	const subscribedEvent = event.subscribe((event) => {
		result = useRunDetails(event.data?.runs[0]?.id, options);
	});

	onDestroy(() => {
		subscribedEvent();
	});

	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return result!;
}
