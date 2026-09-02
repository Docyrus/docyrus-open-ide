# Docyrus Open IDE

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

Install JavaScript dependencies and run the native development command. The npm scripts use the Native SDK-managed Zig 0.16 toolchain when it is installed in its standard location:

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
