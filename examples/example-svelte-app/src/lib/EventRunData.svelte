<script lang="ts">
  import { useEventRunDetails } from '@trigger.dev/svelte'; 
  export let id: string;


  const eventRunDetails =  useEventRunDetails(id);
  const {isLoading, data, isError} = $eventRunDetails;
</script>

<h1 class="title">Event Run Data</h1>

{#if isLoading}
  <p>Loading...</p>
{:else if isError}
  <p>Error</p>
{:else if data}
  <div>Run status: {data.status}</div>
  <div style="display: flex; flex-direction: column; gap: 0.2rem;">
    {#if data.tasks}
      {#each data.tasks as task (task.id)}
        <div style="display: flex; gap: 0.3rem; align-items: center;" >
          <h4>{task.displayKey ?? task.name}</h4>
          <p>{task.icon}</p>
          <p>Status: {task.status}</p>
        </div>
      {/each}
    {/if}
  </div>
  {#if data.output}
    <code>
      <pre>{JSON.stringify(data.output, null, 2)}</pre>
    </code>
  {/if}
{/if}

