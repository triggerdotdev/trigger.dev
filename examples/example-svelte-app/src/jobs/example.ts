import { eventTrigger } from '@trigger.dev/sdk';
import { client } from '../trigger';

// your first job
client.defineJob({
	id: 'svelte-job-testing',
	name: 'testing svelte',
	version: '0.0.1',
	trigger: eventTrigger({
		name: 'test.event.testing'
	}),
	run: async (payload, io, ctx) => {
		await io.logger.info('Hello world!', { payload });

		return {
			message: 'Hello world!'
		};
	}
});
