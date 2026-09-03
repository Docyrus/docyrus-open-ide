# AGENTS.md

Docyrus Open IDE — a macOS-only desktop IDE built on the Native SDK: a Zig core
(`src/main.zig`), declarative native markup (`src/app.native`), and two WebViews
(Monaco editor, `@pierre/trees` file explorer) under `frontend/`.

## Commands

```sh
npm run check   # native check (bundles tree.js first)
npm test        # native test — Zig unit tests in src/main.zig
npm run build   # release build
npm run dev     # run the app locally
```

All four prepend the SDK-managed Zig 0.16 toolchain to `PATH`; run them through
npm, not `zig build` directly. Run `npm run check` and `npm test` before
declaring work done.

## Layout

- `src/main.zig` — Elm-style `Model` / `Msg` / `update`. State lives in
  fixed-size buffers on `Model` (no heap ownership); allocators are arenas
  passed into view accessors only. Unit tests live at the bottom of this file.
- `src/app.native` — the UI, embedded with `@embedFile` and compiled via
  `CompiledMarkupView`. Runtime markup is deliberately disabled; do not
  re-enable it (it crashes on this template-heavy layout).
- `frontend/tree.js` — explorer source, bundled by esbuild into
  `frontend/dist/tree.js`. **Never edit `frontend/dist/tree.js`.**
- `frontend/dist/editor.js`, `editor.css`, `*.html` — hand-written sources, edit
  in place. `frontend/dist/vs/` is vendored Monaco; leave it alone.
- `app.json` — manifest: permissions, capabilities, shell windows/views.
- `release/`, `zig-out/`, `.native/`, `zig-pkg/` are build output and gitignored.

## Bridge commands

A new `workspace.*` command must be added in three places, kept in sync:

1. `app.json` → `bridge.commands` (name, permissions, origins)
2. `src/main.zig` → `bridge_policies`
3. `src/main.zig` → `bridge_handlers` + an `AppHost` method

Every handler follows the existing guards: check `invocation.source.webview_label`
(`error.InvalidBridgeSource`), resolve the project through
`validateBridgeProject`/`activeBridgeProject`, reject paths that fail
`isSafeRelativePath`, and enforce the size caps (`bridge_file_limit`,
`bridge_tree_*`). Handler results are capped at 12 KiB — paginate instead of
growing a payload.

## Conventions

- Match the surrounding style; comments only where a non-obvious constraint
  needs explaining, as in the existing code.
- Widen a `*_capacity` / `max_*` constant rather than introducing dynamic
  allocation in the model.
- New UI goes in `src/app.native` as markup plus a `Msg` variant and an `update`
  arm — not imperative view construction.
- WebView-only messages must be listed in `Msg.view_unbound`.
- Bump the version in both `package.json` and `app.json` together.

## Skills

`.agents/skills/native-sdk` and `.agents/skills/trees` (symlinked into
`.claude/skills`) document the Native SDK and `@pierre/trees` APIs. Read the
relevant one before changing SDK usage or explorer behaviour instead of guessing
API shapes.
