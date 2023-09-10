<script lang="ts">
  
  import {useRunDetails} from "@trigger.dev/svelte"
  export let id: string;

  const runDetails = useRunDetails(id);
  const { data, isLoading, isError } = $runDetails;
</script>

<h1 class="title">Run Data</h1>

{#if isLoading}
  <p>Loading...</p>
{:else if isError}
  <p>Error</p>
{:else if data}
  <div>Run status: {data.status}</div>
  <div style="display: flex; flex-direction: column; gap: 0.3rem;">
    {#if data.tasks}
      {#each data.tasks as task (task.id)}
        <div style="display: flex; gap: 0.5rem;" >
          <h4>{task.name}</h4>
          <p>Status: {task.status}</p>
        </div>
      {/each}
    {/if}
  </div>
{/if}

