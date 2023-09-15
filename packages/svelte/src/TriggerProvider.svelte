<script lang="ts">
	import { BROWSER } from 'esm-env';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import { setTriggerContext } from './providerContext.js';

	export let publicApiKey: string;
	export let apiUrl: string | undefined = undefined;

	setTriggerContext({
		publicApiKey,
		apiUrl
	});
	const publicApiKeyStartsWith = 'pk_';
	const privateApiKeyStartsWith = 'tr_';

	// SvelteKit defaults to rendering routes with SSR.
	// Because of this, you need to disable the query on the server. Otherwise, your query will continue executing on the server asynchronously,
	//  even after the HTML has been sent to the client.
	//https://tanstack.com/query/latest/docs/svelte/ssr
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				enabled: BROWSER
			}
		}
	});

	if (!publicApiKey) {
		throw new Error('TriggerProvider requires `publicApiKey` to be set with a value.');
	}

	$: {
		verifyApiKey(publicApiKey);
	}

	function verifyApiKey(apiKey: string) {
		if (apiKey.startsWith(privateApiKeyStartsWith)) {
			throw new Error(
				`You are using a private API key, you should not do this because the value is visible to the client.`
			);
		}

		if (!apiKey.startsWith(publicApiKeyStartsWith)) {
			console.error(
				`TriggerProvider publicApiKey wasn't in the correct format. Should be ${publicApiKeyStartsWith}...`
			);
		}
	}
</script>

<div>
	<QueryClientProvider client={queryClient}>
		<slot />
	</QueryClientProvider>
</div>
