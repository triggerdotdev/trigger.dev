import { getContext, setContext } from 'svelte';


type TriggerContext = {
	publicApiKey: string;
	apiUrl?: string;
};
const triggerContextKey = "$$_TriggerContext"


export function setTriggerContext(context: TriggerContext) {
	setContext(triggerContextKey, context);
}

export function getTriggerContext(): TriggerContext {
	return getContext<TriggerContext>(triggerContextKey);
}
