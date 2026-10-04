# Immich fork: download conversions

This fork adds converted downloads to Immich. Before a download, a dialog asks for formats and resolutions, e.g. HEIC photos as JPEG or 4K HEVC videos as 1080p H.264. Missing variants are generated on the server, cached, and offered in the download panel, also after the browser was closed. Admins configure it under _Administration → Settings → Download Conversions_.

Only the server image is built. Everything else, including the machine learning image and the mobile app, is upstream.

## Branches and tags

| Ref               | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `main`            | Upstream `main`, untouched.                                                              |
| `fork/vX.Y`       | An upstream release tag plus the fork commits.                                           |
| `vX.Y.Z-fork.N`   | A fork release. Pushing such a tag builds `ghcr.io/<owner>/immich-server:vX.Y.Z-fork.N`. |
| `fork-sync/<tag>` | Temporary branch used while testing a rebase.                                            |

The fork commits stay small and on top of the upstream tag:

1. `feat(server): download variants`
2. `feat(web): download options modal`
3. `chore(fork): regenerate clients`: generated code, rebuilt on every rebase, never merged by hand.
4. `ci(fork): workflows, Dockerfile metadata`

## One-time setup

1. Enable GitHub Actions for the fork (_Actions_ tab).
2. Create a fine-grained personal access token for this repository with _Contents: read and write_ and _Workflows: read and write_, and store it as the repository secret `FORK_SYNC_TOKEN`.
3. Optional repository variables:
   - `AUTO_RELEASE=true` to publish a release automatically after a successful rebase.
   - `FORK_PLATFORMS=linux/amd64` to skip the arm64 build.
4. Run _Fork Sync_ once (`gh workflow run fork-sync.yml`). It disables all upstream workflows, which need self-hosted runners and secrets of immich-app. The workflow does this again on every run, so workflows that upstream adds later are disabled too.
5. After the first release, make the `immich-server` package public (_Packages → immich-server → Package settings_), or `docker login ghcr.io` on the server.

## Releasing

```sh
git tag v3.3.0-fork.1 fork/v3.3 && git push origin v3.3.0-fork.1
```

_Fork Release_ runs the tests, builds amd64 and arm64 images and creates a GitHub release. Increase `N` for fork-only fixes on the same upstream version.

## Updating to a new upstream release

_Fork Sync_ runs daily. When upstream publishes a release, it replays the fork commits onto the new tag, regenerates the API clients and runs the tests. If they pass, it moves `fork/vX.Y` and either tags the release (`AUTO_RELEASE`) or opens a "Ready to release" issue. On conflicts it opens an issue with the commands to resolve them locally.

## Deploying

In `docker-compose.yml`, replace only the server image:

```yaml
immich-server:
  image: ghcr.io/andre161292/immich-server:v3.3.0-fork.1
immich-machine-learning:
  image: ghcr.io/immich-app/immich-machine-learning:v3.3.0
```

Converted files are cached in `<UPLOAD_LOCATION>/download-cache`. You can delete that folder at any time.

## Going back to upstream

The fork does not change the database schema. To switch back, use the upstream image of the same or a newer version. Upstream logs a warning about the unknown `downloadVariants` config key and ignores it. Then delete `<UPLOAD_LOCATION>/download-cache`.
