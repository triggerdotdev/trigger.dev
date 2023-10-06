<script lang="ts">
	import { useRunDetails } from '@trigger.dev/svelte';
	export let id: string;

	const runDetails = useRunDetails(id);
</script>

<h1 class="title">Event Run Data</h1>

{#if $runDetails?.isLoading}
	<p>Loading...</p>
{:else if $runDetails?.isError}
	<p>Error</p>
{:else if $runDetails?.data}
	<div>Run status: {$runDetails.data.status}</div>
	<div style="display: flex; flex-direction: column; gap: 0.2rem;">
		{#if $runDetails.data.tasks}
			{#each $runDetails.data.tasks as task (task.id)}
				<div style="display: flex; gap: 0.3rem; align-items: center;">
					<h4>{task.displayKey ?? task.name}</h4>
					<p>{task.icon}</p>
					<p>Status: {task.status}</p>
				</div>
			{/each}
		{/if}
	</div>
	{#if $runDetails.data.output}
		<code>
			<pre>{JSON.stringify($runDetails.data.output, null, 2)}</pre>
		</code>
	{/if}
{/if}
