import { eventTrigger } from '@trigger.dev/sdk';
import { client } from '../trigger';

// your first job
client.defineJob({
	id: 'test-job',
	name: 'Test Job One',
	version: '0.0.1',
	trigger: eventTrigger({
		name: 'test.event'
	}),
	run: async (payload, io, ctx) => {
		await io.logger.info('Hello world!', { payload });

		return {
			message: 'Hello world!'
		};
	}
});
