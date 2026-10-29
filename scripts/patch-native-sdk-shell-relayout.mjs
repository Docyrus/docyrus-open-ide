import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const marker = "// Docyrus: shell view frames are laid out in window-LOCAL";

// SDK 0.11 separates compiled host-flow actions from the Zig fallback. Patch
// both paths: Zig-core apps use the fallback when no host policy is installed.
for (const file of ["flow.zig", "flow_reference.zig"]) {
  const target = fileURLToPath(
    new URL(`../node_modules/@native-sdk/cli/src/runtime/${file}`, import.meta.url),
  );
  if (!existsSync(target) && file === "flow_reference.zig") continue;
  let source = readFileSync(target, "utf8");
  if (source.includes(marker)) continue;

  const original = `                    const was_open = if (WindowViewMethods().findWindowIndexById(self, state.id)) |index| self.windows[index].info.open else false;
                    WindowViewMethods().updateWindowState(self, state) catch |err| log(self, "window.state.update_failed", @errorName(err), &.{trace.string("label", state.label)});
                    WindowViewMethods().relayoutShellViews(self, state.id) catch |err| log(self, "shell.relayout_failed", @errorName(err), &.{trace.uint("window_id", state.id)});`;

  const replacement = `                    const previous_index = WindowViewMethods().findWindowIndexById(self, state.id);
                    const was_open = if (previous_index) |index| self.windows[index].info.open else false;
                    // Docyrus: shell view frames are laid out in window-LOCAL
                    // bounds (0, 0, w, h), so a pure window MOVE recomputes the
                    // frames it already pushed - yet the relayout still stomps
                    // every webview back to its manifest frame, undoing the
                    // anchored pane geometry \`applyWebPanes\` owns until the
                    // next canvas frame re-snaps it. That gap is a visible
                    // flicker on every drag event, and Docyrus parks its five
                    // panes at a 1x1 manifest frame, so the stomp blanks them.
                    // Relayout only when the size shell layout actually
                    // consumes changed; inset changes ride \`.surface_resized\`,
                    // which relayouts on its own.
                    const shell_bounds_changed = if (previous_index) |index|
                        self.windows[index].info.frame.width != state.frame.width or
                            self.windows[index].info.frame.height != state.frame.height
                    else
                        true;
                    WindowViewMethods().updateWindowState(self, state) catch |err| log(self, "window.state.update_failed", @errorName(err), &.{trace.string("label", state.label)});
                    if (shell_bounds_changed) {
                        WindowViewMethods().relayoutShellViews(self, state.id) catch |err| log(self, "shell.relayout_failed", @errorName(err), &.{trace.uint("window_id", state.id)});
                    }`;

  if (source.includes(original)) {
    writeFileSync(target, source.replace(original, () => replacement));
    continue;
  }

  const actions = [
    [
      "            var was_open = false;",
      "            var was_open = false;\n            var shell_bounds_changed = true;",
    ],
    [
      `                    was_open = if (WindowViewMethods().findWindowIndexById(self, state.id)) |index| self.windows[index].info.open else false;`,
      `                    const previous_index = WindowViewMethods().findWindowIndexById(self, state.id);
                    was_open = if (previous_index) |index| self.windows[index].info.open else false;
                    ${marker}
                    // bounds, so capture the size before window_update and
                    // avoid resetting anchored WebViews on a pure move.
                    shell_bounds_changed = if (previous_index) |index|
                        self.windows[index].info.frame.width != state.frame.width or
                            self.windows[index].info.frame.height != state.frame.height
                    else
                        true;`,
    ],
    [
      `                .window_layout => {
                    const state = event_value.window_frame_changed;
                    WindowViewMethods().relayoutShellViews(self, state.id) catch |err| log(self, "shell.relayout_failed", @errorName(err), &.{trace.uint("window_id", state.id)});
                },`,
      `                .window_layout => {
                    const state = event_value.window_frame_changed;
                    if (shell_bounds_changed) {
                        WindowViewMethods().relayoutShellViews(self, state.id) catch |err| log(self, "shell.relayout_failed", @errorName(err), &.{trace.uint("window_id", state.id)});
                    }
                },`,
    ],
  ];
  for (const [before, after] of actions) {
    if (!source.includes(before)) {
      throw new Error(
        "The installed Native SDK window-frame relayout changed; update the Docyrus shell-relayout patch before building.",
      );
    }
    source = source.replace(before, () => after);
  }
  writeFileSync(target, source);
}
