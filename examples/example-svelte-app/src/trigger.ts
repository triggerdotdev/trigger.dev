import { TriggerClient } from '@trigger.dev/sdk';
import {TRIGGER_API_KEY} from "$env/static/private"

export const client = new TriggerClient({
	id: 'test-svelte',
	apiKey: TRIGGER_API_KEY,
});
