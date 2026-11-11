Workspace rules come first: `E:\projects\AGENTS.md`. Read it when you see that line.

# @rb/arcade

`@rb/arcade` is the shared game library. It uses Halo (`@rb/halo`). The GitHub repository is public `Rick-Boardman/vr-arcade`, checked out at `nexus/vr/arcade`.

There is no package and no build in this foundation commit. The full contract (ownership, install, one Three.js instance, disposal, the Magna boundary) and the first module arrive with ticket `2026-11-09-arcade-course-map`.

Release order: a library change is a pull request with the build green, then merge, then a tag. Consumers pin that tag through `package.json` and an import map that points at `node_modules`. Never a sibling checkout path, and never edit this checkout in passing from a consumer task.

Do not add cloud resources or a recurring cost. Do not pin Three.js in this repository; Halo's peer dependency is the shared copy.
