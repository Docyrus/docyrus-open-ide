import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL("../node_modules/@native-sdk/cli/src/runtime/flow.zig", import.meta.url),
);

const source = readFileSync(target, "utf8");
const marker = "// Docyrus: shell view frames are laid out in window-LOCAL";

if (!source.includes(marker)) {
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

  if (!source.includes(original)) {
    throw new Error(
      "The installed Native SDK window-frame relayout changed; update the Docyrus shell-relayout patch before building.",
    );
  }

  writeFileSync(target, source.replace(original, replacement));
}
