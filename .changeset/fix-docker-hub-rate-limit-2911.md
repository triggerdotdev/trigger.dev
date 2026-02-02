---
"@trigger.dev/cli-v3": patch
---

Fix: Native build server failed with Docker Hub rate limits. Added support for checking checking `DOCKER_USERNAME` and `DOCKER_PASSWORD` in environment variables and logging into Docker Hub before building. (#2911)
