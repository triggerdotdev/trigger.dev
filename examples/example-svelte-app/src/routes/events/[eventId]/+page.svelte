<script lang="ts">
import EventRunData from "$lib/EventRunData.svelte"
import type { PageData } from './$types';
export let data: PageData;
</script>

<main style="padding: 1rem;">
  <EventRunData id={data.eventId} />
</main>