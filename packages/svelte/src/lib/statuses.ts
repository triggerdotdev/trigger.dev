import { createQuery } from '@tanstack/svelte-query';
import {
  GetRunStatuses,
  GetRunStatusesSchema
} from "@trigger.dev/core";
import { useEventDetails } from "./events";
import { getTriggerContext } from './providerContext.js';
import { zodfetch } from './fetch.js';
import { onDestroy } from 'svelte';
import { writable } from 'svelte/store';
import { runResolvedStatuses } from "./runs.js";
 


const defaultRefreshInterval = 1000;

export type RunStatusesOptions = {
  /** How often you want to refresh, the default is 1000. Min is 500  */
  refreshIntervalMs?: number;
};

export type UseRunStatusesResult =
  | {
      fetchStatus: "loading";
      error: undefined;
      statuses: undefined;
      run: undefined;
    }
  | {
      fetchStatus: "error";
      error: Error;
      statuses: undefined;
      run: undefined;
    }
  | ({
      fetchStatus: "success";
      error: undefined;
    } & GetRunStatuses);


const resultStatusesStore = writable<UseRunStatusesResult| undefined>();

export function useRunStatuses(
  runId: string | undefined,
  options?: RunStatusesOptions
): typeof resultStatusesStore {
	const { apiUrl, publicApiKey } = getTriggerContext();

  const queryResult = createQuery({
      queryKey: [`triggerdotdev-runstatuses-${runId}`],
      queryFn: async () => {
        return await zodfetch(GetRunStatusesSchema, `${apiUrl}/api/v1/runs/${runId}/statuses`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${publicApiKey}`,
          },
        });
      },
      enabled: !!runId,
      refetchInterval: (data) => {
        if (data?.run.status && runResolvedStatuses.includes(data.run.status)) {
          return false;
        }
        if (options?.refreshIntervalMs !== undefined) {
          return Math.max(options.refreshIntervalMs, 500);
        }

        return defaultRefreshInterval;
      },
    },
  );
  queryResult.subscribe(queryResult => {
    switch (queryResult.status) {
      case "loading": {
        resultStatusesStore.set( {
          fetchStatus: "loading",
          error: undefined,
          statuses: undefined,
          run: undefined,
        });
        break;
      }
      case "error": {
        resultStatusesStore.set({
          fetchStatus: "error",
          error: queryResult.error as Error,
          statuses: undefined,
          run: undefined,
        });
        break;
      }
      case "success": {
        resultStatusesStore.set( {
          fetchStatus: "success",
          error: undefined,
          run: queryResult.data.run,
          statuses: queryResult.data.statuses,
        });
        break;
      }
    }
  })

  return resultStatusesStore;
}

// const resultStore = writable<{data: GetRunStatuses | undefined, error: Error | null}>({data: undefined, error: null});
const resultStore = writable<UseRunStatusesResult>({
  fetchStatus: "loading",
  error: undefined,
  statuses: undefined,
  run: undefined,
});

export function useEventRunStatuses(
	eventId: string | undefined,
): typeof resultStore{
	const event = useEventDetails(eventId);
	const { apiUrl, publicApiKey } = getTriggerContext();

	const subscribedEvent = event.subscribe(async (event) => {
		if (event.data) {
			// console.log('event: ', event.data?.id);
			
			//we cannot call useRunStatuses inside the subscription, because it would be called outside component initialization, we will have to do it inside the svelte component itself
			
			// Because of useRunStatuses use Context in async function(subscribe) which is detached from the component tree it couses an error.
			// So we use simple fetch. 
      try{
        const req = await zodfetch(GetRunStatusesSchema, `${apiUrl}/api/v1/runs/${event.data?.runs[0].id}/statuses`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${publicApiKey}`
          }
        });


        resultStore.set( {
          fetchStatus: "success",
          error: undefined,
          run: req.run,
          statuses: req.statuses,
        });


      } catch (error) {
        resultStore.set({
          fetchStatus: "error",
          error: error as Error,
          statuses: undefined,
          run: undefined,
        });
			} 
		}
		if(event.error){
			resultStore.set({
        fetchStatus: "error",
        error: event.error as Error,
        statuses: undefined,
        run: undefined,
      });
		}
	});

	onDestroy(() => {
		subscribedEvent();
	});

	return resultStore;
}
