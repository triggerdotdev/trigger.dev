<script lang="ts"  >
	import { useRunDetails, useEventDetails, useEventRunDetails, useEventRunStatuses} from '$lib/trigger.js'

	let status1 : undefined | string = undefined;
	let status2 : undefined | string = undefined;
	let status3 : undefined | string = undefined;


	// Use 2 requests for eventrundetails in the svelte component itself
	let eventId: undefined | string = undefined;
	let runsId : undefined | string = undefined;
	const event = useEventDetails('test:test.event:1696688090005');
	event.subscribe(e => {
		if(e.data){
			eventId = e.data.id;
			runsId = e.data?.runs[0].id;
		}
	})

	$: if(eventId){
		const runs = useRunDetails(runsId);
		runs.subscribe(r => {
			status1 = r.data?.status;
			console.log(r)
		})
	}

	//Use 1 request for eventrundetails

	const store = useEventRunDetails('test:test.event:1696688090005');

	store.subscribe( runs => {
		status2 = runs?.status;
		console.log(status2)
	})


	//Use 1 request for eventrunstatuses

	const store1 = useEventRunStatuses('test:test.event:1696688090005');

	store1.subscribe( runs => {
		status3 = JSON.stringify(runs, null, '.');
		console.log(status3)
	})



</script>

<h1>eventId - {runsId}</h1>
<p>status1 - {status1}</p>
<p>status2 - {status2}</p>

<pre>{status3}</pre>