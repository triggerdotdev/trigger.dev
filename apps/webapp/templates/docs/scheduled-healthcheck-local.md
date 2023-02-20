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

Visit the [README](https://github.com/triggerdotdev/scheduled-healthcheck) has more details on how to test this template.
