<!-- Home.svelte -->
<script>
	import SendTestEventButton from '$lib/SendEvent.svelte';
</script>

<div style="padding: 1rem;">
<h1>Welcome to SvelteKit</h1>
  <SendTestEventButton />
  <button on:click={() => console.log("this is clicking event")}>Events</button>
</div>
