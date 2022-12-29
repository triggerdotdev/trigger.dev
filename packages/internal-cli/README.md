# What does the script do?

It adds integrations to Pizzly, grabbing the appropriate secrets from AWS Secrets Manager.

# Prerequisites

## Adding secrets to AWS Secrets Manager

You need to have added secrets in AWS Secrets Manager for the integrations you want to add.

With the name format `integrations/<service>/<client_id>` and a key value pair of `client_secret`: `<secret_value>`.

## Setup an AWS profile locally

1. [Install the AWS CLI](https://aws.amazon.com/cli/)
2. [Configure the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html#cli-configure-quickstart-config)

# How to use the script

1. Move to the right directory

```bash
cd packages/internal-cli
```

2. Run the script

```bash
pnpm run cli ../../apps/webapp/integrations.yml
```

This will run the script locally, using the `integrations.yml` file in the webapp directory.

# Options

## Environment

`-e` or `--environment`

| Option        | Description                 | Default |
| ------------- | --------------------------- | ------- |
| `development` | The development environment | x       |
| `production`  | The production environment  |         |

Example:

```bash
pnpm run cli ../../apps/webapp/integrations.yml -e production
```

## Pizzly host

`-p` or `--pizzlyhost`

Pass the base url for Pizzly, defaults to `http://localhost:3004`.

## Pizzly secret key

`-s` or `--pizzlysecretkey`

Pass the secret key for Pizzly, defaults to undefined which will work locally in the default configuration.
