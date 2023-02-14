## Run locally

First, clone the repo and install dependencies:

```sh
git clone https://github.com/triggerdotdev/github-stars-to-slack.git
cd github-stars-to-slack
npm install
```

Then create a `.env` file with your development Trigger.dev API Key and GITHUB_REPOSITORY:

```
TRIGGER_API_KEY=<your api key>
GITHUB_REPOSITORY<your github repository> # e.g. triggerdotdev/trigger.dev
```

And finally you are ready to run the process:

```sh
npm run dev
```

You should see a message like the following:

```
[trigger.dev]  ✨ Connected and listening for events [github-stars-to-slack]
```
