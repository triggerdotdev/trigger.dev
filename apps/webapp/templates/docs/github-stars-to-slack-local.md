## 💻 Run locally

First, in your terminal of choice, clone the repo and install dependencies:

```sh
git clone https://github.com/triggerdotdev/github-stars-to-slack.git
cd github-stars-to-slack
npm install
```

Then create a `.env` file at the root of the repository (it's already gitignored) with your development Trigger.dev API Key and GITHUB_REPOSITORY:

```
TRIGGER_API_KEY=<your api key>
GITHUB_REPOSITORY=<your github repository> # e.g. triggerdotdev/trigger.dev
```

And finally you are ready to run the process:

```sh
npm run dev
```

You should see a message like the following:

```
[trigger.dev]  ✨ Connected and listening for events [github-stars-to-slack]
```

## 🧪 Test it

After successfully running this template locally, head over to your [Trigger.dev Dashboard](https://app.trigger.dev) and you should see your newly created workflow:

![workflow list](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/9987dd75-7e0e-4e3f-9280-0ee6d7ad1e00/public)

Click on the workflow in the list and you should come to the Workflow overview page, with a message detailing that you need to authenticate to GitHub to register the webhook for the [newStarEvent](https://docs.trigger.dev/integrations/apis/github/events/new-star):

![workflow overview](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/6e658b62-444f-463a-21ba-43edc91bce00/public)

After connecting to your GitHub account, you'll be redirected back to your Workflow Overview page and the message should be gone (you sometimes need to refresh a few times because we register the webhook in the background):

![workflow connected](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/abcf4856-18ef-45ec-3da6-82d49dc32b00/public)

If you head over to your repo, you should see the newly registered webhook:

![webhook registered](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3248e9df-d16e-4585-fa25-2374bed53000/public)

The easiest way to fire off the `newStarEvent` is to go ahead and star the repo (in this case it's [this repo](https://github.com/triggerdotdev/github-stars-to-slack)). Head back to the Workflow Overview page and you should see a run is in progress:

![workflow run started](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/623f27b3-263a-4562-cdc9-92462e3a7400/public)

Navigate to the Run Details page (by clicking on the run in the list) and you'll notice the "post message to github-stars" step has paused, waiting for your Slack authentication:

![slack auth](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3214985e-05c3-493e-55fd-2ed799c7c500/public)

Once you authenticate your Slack workspace, the run will pickup where it left off and post the message:

![post message](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/e43c2b11-4b70-4de1-2ebf-b92943d99400/public)

Head over to slack to see your newly created message:

![slack message](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/5c238a76-22ee-4837-9379-e3c673211100/public)
