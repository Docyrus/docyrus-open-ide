# Docyrus Open IDE

[![CI](https://github.com/Docyrus/docyrus-open-ide/actions/workflows/ci.yml/badge.svg)](https://github.com/Docyrus/docyrus-open-ide/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Docyrus Open IDE is a lightweight macOS workspace built with the Native SDK. It combines native project and pane chrome with a local Monaco editor, native Markdown and image previews, native PTY terminals, and an `@pierre/trees` File Explorer.

## Install

Apple Silicon Macs can install the latest release with one command:

```sh
curl -fsSL https://github.com/Docyrus/docyrus-open-ide/releases/latest/download/install-mac.sh | bash
```

The installer places `Docyrus Open IDE.app` in `/Applications`, clears the downloaded quarantine attribute for this unsigned preview, and opens the app.

## Features

- Add project folders with the native macOS directory picker.
- Reopen up to ten recent projects from the Add Project dialog.
- Keep a completely independent pane layout, tabs, split mode, explorer state, and terminal pair for each open project.
- Reorder tabs or move them between panes with drag and drop.
- Edit local code, text, and Markdown files in Monaco; Markdown updates its native preview after save.
- Preview local images with the Native SDK Image component.
- Choose Dark Mode, Light Mode, or System Default in Settings.

## Develop

You need macOS on Apple Silicon, Node.js 24 or newer, and the Xcode Command Line Tools. You do not need to install Zig: the Native SDK fetches its pinned Zig 0.16 toolchain into `~/.native/toolchains/` on the first build, and the npm scripts put it on `PATH`.

```sh
npm install
npm run dev
```

`npm run dev` runs the `@pierre/trees` bundle step first and then starts `native dev`. The first terminal-enabled build may fetch the pinned Ghostty dependency.

Useful verification commands:

```sh
npm run check
npm test
npm run build
```

The app deliberately starts without an open project. Use the plus button in the project rail to select a folder.

## Contributing

Contributions are currently accepted from members of the
[Docyrus organization](https://github.com/Docyrus). The repository is public to
read, install, and file issues against; pull requests are merged from org
members while the project settles.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the verification commands,
and the pull request process, and [`.ruler/AGENTS.md`](.ruler/AGENTS.md) for the
codebase invariants (generated files, fixed-size model state, and the
bridge-command checklist).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a
public issue for a security problem.

## License

[Apache License 2.0](LICENSE). Third-party components and their licenses are
listed in [NOTICE](NOTICE).
