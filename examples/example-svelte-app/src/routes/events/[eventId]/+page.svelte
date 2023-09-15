<script lang="ts">
	import EventRunData from '$lib/EventRunData.svelte';
	import { useEventDetails } from '@trigger.dev/svelte';
import type { PageData } from './$types';
export let data: PageData;

	const event = useEventDetails(data.eventId);
</script>

<main style="padding: 1rem;">
	{#if $event.isLoading}
		<p>Loading...</p>
	{:else if $event.isError}
		<p>There was an error</p>
	{:else if $event.isSuccess}
		<EventRunData id={$event.data?.runs[0].id} />
	{/if}
</main>
