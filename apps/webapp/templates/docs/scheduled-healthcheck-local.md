## 💻 Run locally

First, in your terminal of choice, clone the repo and install dependencies:

```sh
git clone https://github.com/triggerdotdev/scheduled-healthcheck.git
cd scheduled-healthcheck
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
[trigger.dev]  ✨ Connected and listening for events [scheduled-healthcheck]
```

## 🧪 Test it

After successfully running this template locally, head over to your [Trigger.dev Dashboard](https://app.trigger.dev) and you should see your newly created workflow:

![workflow list](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/ad020b75-f46c-412b-7b86-9b4ae99e9300/width=1200)

Click on the workflow in the list and then click on the "Test your workflow" button, where you will be able to simulate a scheduled event:

![workflow test](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/4c50afac-56e0-4671-c807-51c05f55e500/width=1200)

Since we setup our workflow to always post to Slack in a test run, after clicking "Run Test" you'll see a message requiring Slack authentication to continue:

![connect to slack](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/61a33e5c-1981-4905-bbdb-f81943c84f00/width=1200)

Once you authenticate your Slack workspace, the run will pickup where it left off and post the message:

![workflow run complete](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/5b9061a4-1fa7-4b4d-7969-e9578adc0700/width=1200)

Head over to slack to see your newly created message:

![slack message](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3995efef-d460-46d5-6973-6f8ad884a600/width=1200)
