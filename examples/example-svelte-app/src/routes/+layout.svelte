<script>
    import {TriggerProvider} from '@trigger.dev/svelte'
	import {
		PUBLIC_API_URL, 
		PUBLIC_TRIGGER_API_KEY,
	} from '$env/static/public';
	import {QueryClientProvider, QueryClient} from '@tanstack/svelte-query'

	const queryClient = new QueryClient()

</script>

    <TriggerProvider publicApiKey={PUBLIC_TRIGGER_API_KEY} apiUrl={PUBLIC_API_URL} >
		<QueryClientProvider client={queryClient}>
	<main>
		<slot />
	</main>

	<footer>
		<p>visit <a href="https://kit.svelte.dev">kit.svelte.dev</a> to learn SvelteKit</p>
	</footer>
		</QueryClientProvider>
    </TriggerProvider>