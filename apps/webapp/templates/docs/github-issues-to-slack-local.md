## 💻 Run locally

First, in your terminal of choice, clone the repo and install dependencies:

```sh
git clone https://github.com/triggerdotdev/github-issues-to-slack.git
cd github-issues-to-slack
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
[trigger.dev]  ✨ Connected and listening for events [github-issues-to-slack]
```

<!--
## 🚀 Deploy

We've made it really easy to deploy this repo to Render.com, if you don't already have a Node.js server to host your triggers.

[Render.com](https://render.com) is a super-fast way to deploy webapps and servers (think of it like a modern Heroku)

<a href="https://render.com/deploy?repo=https://github.com/triggerdotdev/github-issues-to-slack">
  <img width="144px" src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render">
</a>

> **Note** Make sure you use your "live" trigger.dev API Key when deploying to a server -->
