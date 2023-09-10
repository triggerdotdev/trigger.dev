import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';

import { client } from '$trigger';

//this route is used to send events to Trigger.dev
export const POST: RequestHandler = async () => {
	console.log("this is the client",client)
	const event = await client.sendEvent({
		name: 'test.event'
	});

	return json(event);
};
