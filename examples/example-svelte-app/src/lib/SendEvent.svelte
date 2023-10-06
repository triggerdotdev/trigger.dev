<script lang="ts">
	import { goto } from '$app/navigation';
	import { createMutation } from '@tanstack/svelte-query';

	const mutation = createMutation({
		mutationFn: async () => {
			const response = await fetch('/api/send-test-event', { method: 'POST' });
			const data = await response.json();
			goto(`/events/${data.id}`);
		}
	});

	function sendTestEvent() {
		$mutation.mutate();
	}
</script>

<button on:click={sendTestEvent}>Send test event</button>
