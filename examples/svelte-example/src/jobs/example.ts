import { eventTrigger } from '@trigger.dev/sdk';
import { client } from '../trigger';

// your first job
client.defineJob({
	id: 'test-svelte-job',
	name: 'Test sveltekit',
	version: '0.0.1',
	trigger: eventTrigger({
		name: 'test.event'
	}),
	run: async (payload, io, ctx) => {
		await io.wait("waiting", 5)
		await io.logger.info('Hello world!', { payload });

		return {
			message: 'Hello world!'
		};
	}
});
