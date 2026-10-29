# Docyrus Open IDE

[![CI](https://github.com/Docyrus/docyrus-open-ide/actions/workflows/ci.yml/badge.svg)](https://github.com/Docyrus/docyrus-open-ide/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Docyrus Open IDE is a lightweight macOS workspace built with the Native SDK. It combines native project and pane chrome with a local Monaco editor, native Markdown and image previews, native PTY terminals, and an `@pierre/trees` File Explorer.

## Install

Apple Silicon Macs can install the latest release with one command:

```sh
curl -fsSL https://github.com/Docyrus/docyrus-open-ide/releases/latest/download/install-mac.sh | bash
```

The installer verifies the pinned SHA-256 checksum and the Docyrus Developer ID signature, places `Docyrus Open IDE.app` in `/Applications`, clears the downloaded quarantine attribute, and opens the app.

## Features

- Add project folders with the native macOS directory picker.
- Add SSH/SFTP project folders, edit remote files, and open interactive SSH terminals.
- Reopen up to ten recent projects from the Add Project dialog.
- Keep a completely independent pane layout, tabs, split mode, explorer state, and terminal pair for each open project.
- Reorder tabs or move them between panes with drag and drop.
- Edit local code, text, and Markdown files in Monaco; Markdown updates its native preview after save.
- Open code and text documents from Finder's Open With menu. Files outside an added project are collected in the pathless Other Open Files workspace.
- Preview local images with the Native SDK Image component.
- Choose Dark Mode, Light Mode, or System Default in Settings.

## Develop

You need macOS on Apple Silicon, Node.js 24 or newer, the Xcode Command Line Tools, and Homebrew OpenSSL 3 (`brew install openssl@3`). OpenSSL is linked statically; people installing the packaged app do not need Homebrew. You do not need to install Zig: the Native SDK fetches its pinned Zig 0.16 toolchain into `~/.native/toolchains/` on the first build (it asks before downloading), and the npm scripts put it on `PATH`.

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

## Remote projects

Open **Add Project**, enter `ssh://user@host:22/absolute/project/folder` or `sftp://user@host/absolute/project/folder`, and choose **Connect Folder**. IPv6 addresses use brackets, for example `sftp://user@[::1]:2222/home/user/project`. Percent-encode special path characters (`%20` for a space). Both schemes use SFTP for file access and SSH for terminals.

SFTP first tries your SSH agent, then opens a secure password or keyboard-interactive prompt when the server supports it. Load a key with `ssh-add ~/.ssh/id_ed25519` to use agent authentication; encrypted keys remain in the agent. Passwords and verification codes are kept only for the authentication attempt and are never saved in projects, preferences, or logs. Host identity is checked against `~/.ssh/known_hosts` before authentication. For a new server, choose **Open SSH Terminal**, verify its fingerprint against a trusted source, and accept it in OpenSSH. Then refresh the explorer or reconnect. A changed host key is rejected. Both SFTP file access and the SSH terminal support password and keyboard-interactive authentication. Servers configured to require keys still need an agent key. Connection URLs never contain passwords.

Remote projects support the explorer, text/Markdown editing and search, create/rename/copy/delete, and image/PDF previews. Connections and tabs survive restart; the app reconnects when the files are needed. Terminals start in the remote project folder. Use explicit hostnames, usernames, and ports: SFTP does not interpret SSH config aliases, ProxyJump, or custom identity-file settings. Load those identities into the agent instead.

Remote text editing and copies are capped at 768 KiB per file; image/PDF previews at 16 MiB. Explorer snapshots contain up to 4,096 entries and 32 directory levels and indicate incomplete results. Symlinks are omitted and refused by file operations. Recursive copy/delete refuses an incomplete subtree. Saves upload to a sibling temporary file and require the server's `posix-rename@openssh.com` extension, preserving the existing file if upload/rename fails. Preview downloads are stored in the app's macOS cache directory with private file permissions.

The native client uses [libssh2](https://github.com/libssh2/libssh2), pinned to upstream revision `94629f16bb313e522276b53a50f8d89c6eee81b0` (2026-10-28) in `build.zig.zon`, including fixes newer than release 1.11.1, plus maintained OpenSSL 3 from Homebrew. Update the pinned source URL and Zig content hash together after reviewing upstream security changes. A custom OpenSSL installation can be selected with `zig build -Dopenssl-prefix=/absolute/prefix`.

`npm run test:remote` starts isolated loopback-only OpenSSH and ssh2 test servers with temporary keys. It checks real SFTP operations, hashed known-host entries, unknown/changed host rejection, traversal/symlink refusal, upload limits, password authentication, multi-step keyboard-interactive authentication, cancellation, and time spent entering a response. The password fixtures use synthetic credentials and never change your system password, keys, agent, known_hosts, or Remote Login settings. On macOS, run the full suite outside a nested sandbox so sshd can initialize its own sandbox.

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
