## Guide on releasing a new version

### Automated release (v4+)

Releases are fully automated via CI:

1. PRs merge to `main` with changesets (for package changes) and/or `.server-changes/` files (for server-only changes).
2. The [changesets-pr.yml](./.github/workflows/changesets-pr.yml) workflow automatically creates/updates the `changeset-release/main` PR with version bumps and an enhanced summary of all changes. Consumed `.server-changes/` files are removed on the release branch (same approach changesets uses for `.changeset/` files — they're deleted on the branch, so merging the PR cleans them up).
3. When ready to release, merge the changeset release PR into `main`.
4. The [release.yml](./.github/workflows/release.yml) workflow automatically:
   - Publishes all packages to npm
   - Creates a single unified GitHub release (e.g., "trigger.dev v4.3.4")
   - Tags and triggers Docker image builds
   - After Docker images are pushed, updates the GitHub release with the exact GHCR tag link

### What engineers need to do

- **Package changes**: Add a changeset with `pnpm run changeset:add`
- **Server-only changes**: Add a `.server-changes/` file (see `.server-changes/README.md`)
- **Mixed PRs**: Just the changeset is enough

See `CHANGESETS.md` for full details on changesets and server changes.

### Legacy release (v3)

1. Merge in the changeset PR into main, making sure to cancel both the release and publish github actions from that merge.
2. Pull the changes locally into main
3. Run `pnpm i` which will update the pnpm lock file with the new versions
4. create a commit with "Release 3.x.x" and push. This will build and release the packages
5. Create a git tag on that release commit with v.docker.3.x.x and push the tag to origin. This will publish the `v3.x.x` docker image to GitHub Container Registry.
6. Once the image is built and pushed, create a new GitHub release and select the tag you just created, along with the previous tag that was released.
7. This will generate some release notes. Edit out the package changes and leave only the server changes.
8. Name the release `@trigger.dev/docker@3.x.x`
9. Include the package link (e.g. https://github.com/triggerdotdev/trigger.dev/pkgs/container/trigger.dev/278459584?tag=v3.x.x)
10. Once the packages have been published, head over to the [v2-legacy repo](https://github.com/triggerdotdev/v2-legacy.trigger.dev) and follow the instructions in the README for creating a matching release.
11. Before deploying to cloud, compare the differences in the previously created release and double check to see if there are any migrations with indexes created concurrently, and make sure to run those before deploying.
