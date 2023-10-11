import { createQuery, type CreateQueryResult } from '@tanstack/svelte-query';
import { GetEventSchema, type GetEvent } from '@trigger.dev/core';
import { getTriggerContext } from './providerContext.js';
import { zodfetch } from './fetch.js';
import { onDestroy } from 'svelte';
import { writable } from 'svelte/store';
import { runResolvedStatuses, type RunDetailOptions } from "./runs.js";
import { urlWithSearchParams, GetRunSchema, type GetRun } from '@trigger.dev/core';
const defaultRefreshInterval = 1000;

export type UseEventDetailsResult = CreateQueryResult<GetEvent>;
export function useEventDetails(eventId: string | undefined ): UseEventDetailsResult {
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
		enabled: !!eventId,
	});
}



type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>
type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

const resultStore = writable<PartialBy<GetRun, 'statuses'> | undefined>();

export function useEventRunDetails(
	eventId: string | undefined,
	options?: RunDetailOptions
): typeof resultStore{
	const event = useEventDetails(eventId);
	const { apiUrl, publicApiKey } = getTriggerContext();

	const subscribedEvent = event.subscribe(async (event) => {
		if (event.data) {
			// console.log('event: ', event.data?.id);
			
			const url = urlWithSearchParams(`${apiUrl}/api/v1/runs/${event.data?.runs[0].id}`, options);

			//we cannot call useRunDetails inside the subscription, because it would be called outside component initialization, we will have to do it inside the svelte component itself
			
			// Because of useRunDetails use Context in async function(subscribe) which is detached from the component tree it couses an error.
			// So we use simple fetch. 
			const req = await zodfetch(GetRunSchema, url, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${publicApiKey}`
				}
			});

			resultStore.set(req);
		}
	});

	onDestroy(() => {
		subscribedEvent();
	});

	return resultStore;
}
