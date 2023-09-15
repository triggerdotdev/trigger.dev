import { createQuery, type CreateQueryResult } from '@tanstack/svelte-query';
import { GetEventSchema, type GetEvent } from '@trigger.dev/core';
import { getTriggerContext } from './providerContext.js';
import { zodfetch } from './fetch.js';
import { runResolvedStatuses } from './runs.js';

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

//we cannot call useRunDetails inside the subscription, because it would be called outside component initialization, we will have to do it inside the svelte component itself
//I'm still looking for better ways of doing this.

// export function useEventRunDetails(
// 	eventId: string | undefined,
// 	options?: RunDetailOptions
// ): RunDetailsResult | undefined {
// 	const event = useEventDetails(eventId);
// 	let result: RunDetailsResult | undefined;
// 	const subscribedEvent = event.subscribe((event) => {
// 		if (event.data) {
// 			console.log('event: ', event.data?.id);
// 			const runs = useRunDetails(event.data?.runs[0].id, options);
// 			runs.subscribe((runs) => {
// 				console.log('runs: ', runs);
// 				result = runs;
// 			});
// 		}
// 	});

// 	onDestroy(() => {
// 		subscribedEvent();
// 	});

// 	return result;
// }
