<script lang="ts">
    import {useEventDetails} from "@trigger.dev/svelte"
  export let id: string;

  const eventDetails =  useEventDetails(id)
  const { data, isLoading, error } = $eventDetails;


</script>

<h1 class="title">Event</h1>

{#if isLoading}
  <p>Loading</p>
{:else if error}
  <pre>{JSON.stringify(error, null, 2)}</pre>
{:else if data}
  <p>
    <strong>Event ID:</strong> {data.id}
  </p>
{/if}

