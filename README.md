# @rb/arcade

`@rb/arcade` is the shared game library for the VR games. It uses Halo (`@rb/halo`). The owner accepted this package name, the folder `nexus/vr/arcade`, and a public GitHub repository `Rick-Boardman/vr-arcade` on 2026-11-11.

## Status

Foundation only. This commit has no module, no `package.json`, and no build. Nothing here is installable yet, and this repository adds no cloud resources and no recurring cost.

## What arrives next

The full contract — ownership, install, one Three.js instance, disposal, and the Magna boundary — arrives with ticket [2026-11-09-arcade-course-map](https://github.com/Rick-Boardman/nexus/blob/main/backlog/tickets/waiting/2026-11-09-arcade-course-map.md). That ticket also adds the first module and replaces this README with the full one. The backlog lives in the private `Rick-Boardman/nexus` repository; the ticket file is `backlog/tickets/**/2026-11-09-arcade-course-map.md`.

## Use

When a release tag exists, a consumer pins it in `package.json` as `github:Rick-Boardman/vr-arcade#vX.Y.Z` and imports `@rb/arcade/...` through an import map that points at `node_modules`. A sibling checkout path is not a dependency.

## Layout

`README.md`, `AGENTS.md`, and `.gitignore` are the whole repository. Source directories arrive with the first module.

## Constraints

Do not pin Three.js in this repository. Halo's peer dependency is the shared copy, so a game keeps one Three.js instance. The release order is in `AGENTS.md`: library pull request with the build green, merge, tag, then consumers move their pin.
