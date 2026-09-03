import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL(
    "../node_modules/@native-sdk/cli/src/primitives/canvas/widget_access.zig",
    import.meta.url,
  ),
);

const source = readFileSync(target, "utf8");
const marker = "// Docyrus uses the web-style pointing hand for actionable controls.";

if (!source.includes(marker)) {
  const original = `pub fn cursorForWidgetHit(hit: ?WidgetHit) WidgetCursor {
    const target = hit orelse return .arrow;
    if (target.role == .link and !target.state.disabled) return .pointing_hand;
    return cursorForWidgetTarget(target.kind, target.state);
}`;
  const replacement = `pub fn cursorForWidgetHit(hit: ?WidgetHit) WidgetCursor {
    const target = hit orelse return .arrow;
    if (target.state.disabled) return .arrow;
    // Docyrus uses the web-style pointing hand for actionable controls.
    switch (target.role) {
        .link, .button, .menuitem, .listitem, .tab, .checkbox, .radio, .switch_control, .slider, .treeitem => return .pointing_hand,
        else => {},
    }
    return cursorForWidgetTarget(target.kind, target.state);
}`;

  if (!source.includes(original)) {
    throw new Error(
      "The installed Native SDK cursor implementation changed; update the Docyrus cursor patch before building.",
    );
  }

  writeFileSync(target, source.replace(original, replacement));
}
