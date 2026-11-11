Workspace rules come first: `E:\projects\AGENTS.md`. Read it when you see that line.

# @rb/arcade

`@rb/arcade` is the shared game library. It uses Halo (`@rb/halo`). The GitHub repository is public `Rick-Boardman/vr-arcade`, checked out at `nexus/vr/arcade`.

`./audio` owns shared audio lifecycle through adapters. `./presentation` owns in-world name tags, appearance on game meshes, and remote-player presentation. `./course` owns seeded courses, lanes, map validation, and the road ribbon over Halo's curve/surface primitives. `./racing` owns progress, laps, gaps, standings and finish; physics, network authority and scoring policy stay in games. Run `npm ci` and `npm run build` (syntax checks and Node tests); browser ESM source is the package output.

Release order: a library change is a pull request with the build green, then merge, then a tag. Consumers pin that tag through `package.json` and an import map that points at `node_modules`. Never a sibling checkout path, and never edit this checkout in passing from a consumer task.

Do not add cloud resources or a recurring cost. Do not pin Three.js in this repository; Halo's peer dependency is the shared copy.
