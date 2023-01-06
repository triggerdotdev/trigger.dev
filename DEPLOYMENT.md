# Trigger.dev Deployment Guide

## StreamNative Cloud - Hosted Pulsar

### Generic client credentials

```sh
snctl auth export-service-account webapp-sa --key-file webapp-credentials.json
snctl auth export-service-account wss-sa --key-file wss-credentials.json
```

### Topics

#### Triggers (`persistent://triggerdotdev/workflows/triggers`)

Events that trigger workflows to run. These are sent by the "platform" and read by the Web Socket Servers, which then coordinate with the hosts for running the workflows

#### Run Commands (`persistent://triggerdotdev/workflows/run-commands`)

These are events that come from hosts and are published by the Web Socket Servers, e.g. Sending Integration Requests, Sending Logs, Initializing a Delay

#### Run Command Responses (`persistent://triggerdotdev/workflows/run-command-responses`)

These are events that come from the platform and are read by the Web Socket Servers, to resolve or reject a previous Run Command

#### Integration Requests (`persistent://triggerdotdev/queues/integration-requests`)

This is an internal queue used by the platform to perform integration requests, and retry them.

#### App Task Queue (`persistent://triggerdotdev/queues/background-tasks`)

This is an internal queue used by the platform to do tasks in a queue. Basically a background job system.
