# Trigger.dev CLI

A CLI that allows you to create, run locally and deploy Trigger.dev background tasks.

Note: this only works with Trigger.dev v3 projects and later. For older projects use the [@trigger.dev/cli](https://www.npmjs.com/package/@trigger.dev/cli) package.

Trigger.dev is an open source platform that makes it easy to create event-driven background tasks directly in your existing project.

## Usage

### Login

Logs that machine into Trigger.dev by creating a new Personal Access Token and storing it on the local machine. Once you're logged in you can perform the other actions below.

```sh
npx trigger.dev@latest login
```

| Option      | Short option | Description                                                          |
| ----------- | ------------ | -------------------------------------------------------------------- |
| `--api-url` | `-a`         | Set the API URL for Trigger.dev, defaults to https://api.trigger.dev |

### Update

Will update all of your @trigger.dev packages in your package.json to the latest version.

```sh
npx trigger.dev@latest update
```

You can pass the path to the folder that your package.json file lives in:

```sh
npx trigger.dev@latest update ./myapp
```

| Option | Short option | Description                                                |
| ------ | ------------ | ---------------------------------------------------------- |
| `--to` | `-t`         | The version to update to (ex: 2.1.4), defaults to "latest" |

### Who Am I?

Shows the current user that is logged in.

```sh
npx trigger.dev@latest whoami
```

| Option      | Short option | Description                                                          |
| ----------- | ------------ | -------------------------------------------------------------------- |
| `--api-url` | `-a`         | Set the API URL for Trigger.dev, defaults to https://api.trigger.dev |
