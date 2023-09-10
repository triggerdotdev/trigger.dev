// import { createSvelteRoute } from '@trigger.dev/sveltekit';
// import { json } from '@sveltejs/kit';
// import type { RequestHandler } from './$types.js';
import { createSvelteRoute } from '@trigger.dev/sveltekit';

import {client} from  '$trigger';

// Replace this with your own jobs
import '$jobs/example';

//this route is used to send and receive data with Trigger.dev
// export const POST = async () => {
// 	createSvelteRoute(client);
// 	// const response = await client.handleRequest(request);

// 	// if (!response) {
// 	// 	return json({ error: 'Resource not found' }, { status: 404 });
// 	// }

// 	// return json(response.body, { status: response.status });
// };

export const POST = () => createSvelteRoute(client);