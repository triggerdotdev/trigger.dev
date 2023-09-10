<script>
    import {TriggerProvider} from '@trigger.dev/svelte'
	import {QueryClientProvider, QueryClient} from '@tanstack/svelte-query'

	const queryClient = new QueryClient()

</script>

    <TriggerProvider publicApiKey="pk_dev_fayCzrGd0G5jRCtlWACE" >
		<QueryClientProvider client={queryClient}>
	<main>
		<slot />
	</main>

	<footer>
		<p>visit <a href="https://kit.svelte.dev">kit.svelte.dev</a> to learn SvelteKit</p>
	</footer>
		</QueryClientProvider>
    </TriggerProvider>