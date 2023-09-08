// import { writable, type Writable } from 'svelte/store';
import { getContext, setContext } from 'svelte';


type TriggerContext = {
	publicApiKey: string;
	apiUrl?: string;
};
const triggerContextKey = "$$_TriggerContext"


export function setTriggerContext(context: TriggerContext) {
	// const context = writable<TriggerContextValue>();
	setContext(triggerContextKey, context);
}

export function getTriggerContext(): TriggerContext {
	return getContext<TriggerContext>(triggerContextKey);
}
