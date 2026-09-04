import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A terminal's grid is sized from its laid-out frame, then clamped so
// cols * rows stays under the per-view glyph budget -- and the clamp gives up
// ROWS to keep columns. At the stock 8192-glyph budget a full-width pane on a
// 1920-wide display asks for 209x52 and is handed 209x34, so the terminal
// stops a third of the way short of the panel's height. Doubling the per-view
// glyph capacity lifts the ceiling past a maximized pane on that display.
//
// Cost is fixed-capacity address space in the Runtime, not resident memory:
// 112 B of per-view glyph arrays x 8192 more entries x 32 view slots, about
// 31 MiB more reserved, with pages touched only as a view paints that many
// glyphs. Docyrus paints one canvas view.

const patches = [
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/canvas_limits.zig",
    marker: "// Docyrus raised this so a full-width terminal pane can fill its height.",
    original: "pub const max_canvas_glyphs_per_view: usize = 8192;",
    replacement: `// Docyrus raised this so a full-width terminal pane can fill its height.
pub const max_canvas_glyphs_per_view: usize = 16384;`,
  },
  {
    file: "../node_modules/@native-sdk/cli/src/primitives/canvas/terminal_grid.zig",
    marker: "// Docyrus: mirrors the raised per-view glyph budget.",
    original: "pub const max_cells: usize = 7168;",
    replacement: `// Docyrus: mirrors the raised per-view glyph budget.
pub const max_cells: usize = 15360;`,
  },
  {
    file: "../node_modules/@native-sdk/cli/src/primitives/canvas/terminal_grid.zig",
    marker: "pub const widget_glyph_budget: usize = 16384 - 512;",
    original: "pub const widget_glyph_budget: usize = 8192 - 512;",
    replacement: "pub const widget_glyph_budget: usize = 16384 - 512;",
  },
];

for (const patch of patches) {
  const target = fileURLToPath(new URL(patch.file, import.meta.url));
  const source = readFileSync(target, "utf8");
  if (source.includes(patch.marker)) continue;

  if (!source.includes(patch.original)) {
    throw new Error(
      `The installed Native SDK terminal cell budget changed (${patch.original}); update the Docyrus terminal-cell patch before building.`,
    );
  }

  writeFileSync(target, source.replace(patch.original, patch.replacement));
}
