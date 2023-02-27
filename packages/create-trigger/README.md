## ✨ Create Trigger - Get started writing Trigger.dev code quickly

Trigger.dev is an open source platform that makes it easy to create event-driven background tasks directly your codebase.

You can run these tasks (or "workflows" as we like to cal them) in your existing Node.js repo, but if you don't have one of those (👋 Next.js devs) or you just want to try us out without the setup, this `create-trigger` CLI will scaffold out a project for you in just a few seconds, either starting from scratch or using one of our many [templates](https://app.trigger.com/templates).

## 💻 Usage

To scaffold out a new project using `create-trigger`, run any of the following three commands and answer the prompts:

### npm

```sh
npm create trigger@latest
```

### yarn

```sh
yarn create trigger
```

### pnpm

```sh
pnpm create trigger@latest
```

You can also specify the [template](https://app.trigger.com/templates) you want to use by passing an argument to the command, like so:

```sh
npm create trigger@latest github-stars-to-slack
```

## Advanced Usage

| Option/Flag         | Description                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `[template]`        | The name of the template to use, e.g. basic-starter                                                                               |
| `-p, --projectName` | The name of the project, as well as the name of the directory to create. Can be a path to a directory, e.g. ~/projects/my-project |
| `-k, --apiKey`      | The development API key to use for the project. Visit https://app.trigger.dev to get yours                                        |
| `--noGit`           | Explicitly tell the CLI to not initialize a new git repo in the project                                                           |
| `--noInstall`       | Explicitly tell the CLI to not run the package manager's install command                                                          |

## Folder structure

```
├── LICENSE
├── README.md
├── package.json
├── render.yaml
├── .env
├── .env.example
├── src
│   └── index.ts
└── tsconfig.json
```

### `src/index.ts`

All your Trigger.dev workflow code will be in here, and this is the part you can start customizing.

### `.env`

If provided, we'll save your development API Key here so running the project can connect to our servers.

### `render.yaml`

A [Render.com](https://render.com) Blueprint file that makes it easy to deploy your repo as a Background Worker.

### `README.md`

Contains useful instructions for getting started with the repo, including how to customize it, running it locally, testing it, and deploying it.

## Next steps

After you successfully scaffold out your project, take a look at the README. If you have any issues, please feel free to email us at hello@trigger.dev, or you can ask a question in our [Discord server](https://discord.gg/nkqV9xBYWy)
