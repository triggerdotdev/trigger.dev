# GitHub Action Tests

This directory contains necessary files to allow local testing of GitHub Actions workflows, composite actions, etc. You will need to install [act](https://github.com/nektos/act) to perform tests.

## Workflow tests

Trigger specific workflow files by specifying their full path:

```
act -W .github/workflow/release.yml
```

You will likely need to override any custom runners we use, e.g. buildjet. For example:

```
override=catthehacker/ubuntu:act-latest

act -W .github/workflow/release.yml \
    -P buildjet-8vcpu-ubuntu-2204=$override

# override multiple images at the same time
act -W .github/workflow/release.yml \
    -P buildjet-8vcpu-ubuntu-2204=$override \
    -P buildjet-16vcpu-ubuntu-2204=$override
```

Trigger with specific event payloads to test pushing to branches or tags:

```
override=catthehacker/ubuntu:act-latest

# simulate push to main
act -W .github/workflow/publish.yml \
    -P buildjet-8vcpu-ubuntu-2204=$override \
    -P buildjet-16vcpu-ubuntu-2204=$override \
    -e .github/events/push-tag-main.json

# simulate a `build-` prefixed tag
act -W .github/workflow/publish.yml \
    -P buildjet-8vcpu-ubuntu-2204=$override \
    -P buildjet-16vcpu-ubuntu-2204=$override \
    -e .github/events/push-tag-buld.json
```

By default, `act` will send a push event. To trigger a different event:

```
# basic syntax
act <EVENT> ...

# simulate a pull request
act pull_request

# only trigger a specific workflow
act pull_request -W .github/workflow/pr_checks.yml
```

## Composite action tests

The composite (custom) action tests can be run by triggering the `test-actions` workflow:

```
act -W .github/test/test-actions.yml
```

## Helpful flags

- `--pull=false` - perform fully offline tests if all images are already present
- `-j <job_name>` - run the specified job only
- `-l push` - list all workflows with push triggers
