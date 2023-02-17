## 💻 Run locally

First, in your terminal of choice, clone the repo and install dependencies:

```sh
git clone https://github.com/triggerdotdev/basic-starter.git
cd basic-starter
npm install
```

Then execute the following command to create a `.env` file with your development Trigger.dev API Key:

```sh
echo "TRIGGER_API_KEY=<APIKEY>" >> .env
```

And finally you are ready to run the process:

```sh
npm run dev
```

You should see a message output in your terminal like the following:

```
[trigger.dev]  ✨ Connected and listening for events [basic-starter]
```

## 🧪 Test it

After successfully running this template locally, head over to your [Trigger.dev Dashboard](https://app.trigger.dev) and you should see your newly created workflow:

![workflow list](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/34fb0fa8-3649-4c8e-4b27-d31540f3cb00/width=1200)

Click on the workflow in the list and you should come to the Workflow overview page:

![workflow overview](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/8d68044b-104f-472c-837f-dd1ca62e9d00/width=1200)

Click on the "Test your workflow" button and fill in the JSON needed for [this workflow's](src/index.ts#L7) customEvent Trigger:

![workflow test](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/dbfdfeed-4230-44ec-5e6c-1e87412a5200/width=1200)

After click "Run Test" you'll be redirected to the Run Details page:

![workflow run](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/18b46eaa-95d1-49c5-774f-507819360a00/width=1200)
