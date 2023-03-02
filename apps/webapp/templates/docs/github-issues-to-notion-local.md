## 💻 Run locally

First, in your terminal of choice, clone the repo and install dependencies:

```sh
git clone https://github.com/triggerdotdev/github-issues-to-notion.git
cd github-issues-to-notion
npm install
```

Then create a `.env` file at the root of the repository (it's already gitignored) with your development Trigger.dev API Key and NOTION_DATABASE_ID:

```
TRIGGER_API_KEY=<your api key>
NOTION_DATABASE_ID=<your notion database id> # get this by sharing the URL of your database, the ID is after the name but before the question mark
```

And finally you are ready to run the process:

```sh
npm run dev
```

You should see a message like the following:

```
[trigger.dev]  ✨ Connected and listening for events [github-issues-to-notion]
```
