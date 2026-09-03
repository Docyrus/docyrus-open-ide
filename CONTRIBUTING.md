# Contributing to Docyrus Open IDE

Thanks for helping build Docyrus Open IDE.

## Who can contribute right now

Contributions are currently accepted from **members of the [Docyrus organization](https://github.com/Docyrus)**.
The repository is public so anyone can read the code, file issues, and install
releases, but pull requests are merged only from org members while the project
settles. If you are outside the org and want to change something, open an issue
first — we will tell you whether we can take the patch.

If you are an org member and cannot push a branch, ask an owner to add you to
the `system` team.

## Prerequisites

- **macOS on Apple Silicon.** The app targets macOS only; there is no Linux or
  Windows build.
- **Node.js 24 or newer** (`@native-sdk/cli` sets `engines.node >= 24`).
- **Xcode Command Line Tools** — `xcode-select --install`.

You do **not** need to install Zig yourself. The Native SDK fetches its pinned
Zig 0.16 toolchain into `~/.native/toolchains/` on the first build, and the npm
scripts put that directory on `PATH`. It asks before downloading the first time;
answer yes, or pass the flag through npm as `npm run dev -- --yes`.

## Setup

```sh
git clone https://github.com/Docyrus/docyrus-open-ide.git
cd docyrus-open-ide
npm install
npm run dev
```

`npm install` runs `postinstall` → `scripts/patch-native-sdk-pointer.mjs`, which
patches the installed SDK's cursor behaviour inside `node_modules`. If that
script throws `The installed Native SDK cursor implementation changed`, the
pinned SDK version moved and the patch needs updating — say so in an issue
rather than deleting the script.

The first build with terminals enabled fetches the pinned Ghostty dependency and
can take several minutes.

The app starts with no project open. Use the **+** button in the project rail to
pick a folder.

## Before you open a pull request

```sh
npm run check   # markup, manifest, and core validation
npm test        # Zig unit tests in src/main.zig
npm run build   # release build — CI does not run this, so run it yourself
```

`check`, `test`, and `build` all regenerate `frontend/dist/tree.js` first, so run
them before committing if you touched `frontend/tree.js`.

CI runs `check` and `test` only — the ReleaseFast build is too slow to gate every
pull request, and `native test` already compiles the app in Debug. That makes
`npm run build` your responsibility for anything touching the build graph,
`app.json`, or bridge commands: a release-only break will not be caught for you.

## Working in this codebase

The layout, invariants, and the bridge-command checklist live in
[`.ruler/AGENTS.md`](.ruler/AGENTS.md) — read it before your first change. The
points that bite newcomers:

- **`frontend/dist/tree.js` is generated** by esbuild from `frontend/tree.js`.
  Never edit it by hand. `frontend/dist/editor.js` and `editor.css`, by
  contrast, *are* the sources and are edited in place.
- **`frontend/dist/vs/` is vendored Monaco.** Leave it alone; upgrade it by
  bumping `monaco-editor` and recopying.
- **Model state uses fixed-size buffers.** Widen a `*_capacity` / `max_*`
  constant rather than introducing dynamic allocation.
- **A new bridge command must be added in three places** — `app.json`
  `bridge.commands`, `bridge_policies`, and `bridge_handlers` — and must keep
  the existing guards (webview-label check, project validation,
  `isSafeRelativePath`, size caps).
- **Runtime markup is deliberately disabled.** Do not re-enable it.

## Pull requests

- Branch from `main`: `git switch -c your-name/short-description`.
- Keep one logical change per PR. Split refactors out from behaviour changes.
- Write commit subjects in the imperative mood, matching the existing history
  (`Fix file explorer WebView loading`).
- Fill in the PR template: what changed, why, and how you verified it on a real
  window — this app's behaviour is hard to judge from a diff alone.
- CI must be green and one `CODEOWNERS` review is required before merge.
- Bump the version in **both** `package.json` and `app.json` when releasing;
  don't bump it in ordinary PRs.

## Reporting bugs

Open an issue with the bug template. Include your macOS version, the app
version, and the log at
`~/Library/Logs/dev.native_sdk.app/native-sdk.jsonl` when the app misbehaves at
runtime.

Security issues go through [SECURITY.md](SECURITY.md), not the issue tracker.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), per section 5 of that license.
