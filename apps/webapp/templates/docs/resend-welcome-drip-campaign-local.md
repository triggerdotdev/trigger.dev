## 💻 Run locally

First, in your terminal of choice, clone the repo and install dependencies:

```sh
git clone https://github.com/triggerdotdev/resend-welcome-drip-campaign.git
cd resend-welcome-drip-campaign
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
[trigger.dev]  ✨ Connected and listening for events [resend-welcome-drip-campaign]
```

## 🧪 Test it

After successfully running this template locally, head over to your [Trigger.dev Dashboard](https://app.trigger.dev) and you should see your newly created workflow:

![workflow list](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/c84a7d7c-8cf4-48e9-475d-9bcb30f3c300/width=1200)

Click on the workflow in the list and you should come to the Workflow overview page:

![workflow overview](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/8ce61584-6ad9-411b-41a8-2dae9d612400/width=1200)

Click on the "Test your workflow" button and fill in the JSON needed for [this workflow's](src/index.tsx#L14) customEvent Trigger:

![workflow test](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/64367e7d-2aa0-43a1-f1db-ac84e02e4f00/width=1200)

After click "Run Test" you'll be redirected to the Run Details page and you should see a prompt for entering your Resend.com API Key:

> Resend.com is currently in private beta, but if you signup for their waitlist, give us a shout on [our Discord](https://discord.gg/CzBqJnYq9r) and we'll help you get in.

![api key](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/c4914a82-32b0-4edc-f046-124213c3df00/width=1200)

After hitting "Save" the Run will pickup where it left off and make the request to Resend.com to send your email. You can even see a preview of the email right inside the step:

![preview](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/e5cc5b2a-cf4b-476b-73c4-217cf98ffc00/width=1200)
