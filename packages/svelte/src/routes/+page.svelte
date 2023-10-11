<script lang="ts"  >
	import { useRunDetails, useEventDetails, useEventRunDetails, useEventRunStatuses, useRunStatuses} from '$lib/trigger.js'

	let status1 : undefined | string = undefined;
	let status2 : undefined | string = undefined;
	let status3 : undefined | string = undefined;


	// Use 2 requests for eventrundetails in the svelte component itself
	let eventId: undefined | string = undefined;
	let runId : undefined | string = undefined;
	const event = useEventDetails('test:test.event:1696688090005');
	event.subscribe(e => {
		if(e.data){
			eventId = e.data.id;
			runId = e.data?.runs[0].id;
		}
	})

	$: if(runId){
		const runs = useRunDetails(runId);
		runs.subscribe(r => {
			status1 = r.data?.status;
			// console.log(r)
		})

		const store2 = useRunStatuses(runId);

		store2.subscribe( runs => {
			console.log(runs?.fetchStatus)
		})
	}

	//Use 1 request for eventrundetails

	const store = useEventRunDetails('test:test.event:1696688090005');

	store.subscribe( runs => {
		status2 = runs?.status;
		// console.log(status2)
	})


	//Use 1 request for eventrunstatuses

	const store1 = useEventRunStatuses('test:test.event:1696688090005');

	store1.subscribe( runs => {
		status3 = JSON.stringify(runs, null, '.');
		console.log(status3)
	})

	//Use 1 request for eventrunstatuses


	




</script>

<h1>eventId - {runId}</h1>
<p>status1 - {status1}</p>
<p>status2 - {status2}</p>

<pre>{status3}</pre>