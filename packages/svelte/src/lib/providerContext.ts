import { getContext, setContext } from 'svelte';


export type TriggerContext = {
	publicApiKey: string;
	apiUrl?: string;
};
const triggerContextKey = "$$_TriggerContext"


export function setTriggerContext(context: TriggerContext) {
	console.log('setContext')
	setContext(triggerContextKey, context);
}

export function getTriggerContext(): TriggerContext {
	console.log('getContext')
	return getContext<TriggerContext>(triggerContextKey);
}


