import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Two fixes to terminal scrollback, both hit while trying to scroll back
// through a long `claude` session in a terminal pane.
//
// 1. DIRECTION. The gpu-surface wire carries ONE scroll convention: a positive
//    `delta_y` moves the viewport toward LATER content. Every scroll region
//    reads it that way (the SDK's own scroll-driver test dispatches
//    `delta_y = 24` and watches the offset go 24 -> 48), and the native
//    NSScrollView hand-off is defined to agree with it. The terminal-session
//    store reads the opposite sign: its `wheel` treats a positive delta as
//    "reveal history" and negates before calling ghostty's `delta_row`, where
//    positive means scroll DOWN. So a scroll-UP gesture over a terminal
//    arrived negative, became a positive `delta_row`, and no-oped against the
//    already-pinned live screen -- the scrollback was unreachable, while
//    scrolling DOWN walked backwards through it. Fix at the seam, not in the
//    store: the store's convention is documented and unit-tested on its own
//    terms, so the wire delta is negated where the two meet.
//
// 2. DEPTH. Sessions cap scrollback at 1 MB. A ghostty page holds 215 rows in
//    roughly 200 KB, so that is about a thousand lines -- short of a resumed
//    agent session. The cap is a ceiling on lazily allocated pages, not a
//    reservation, so raising it to 10 MB (~10k lines, a normal terminal's
//    default) costs nothing until a terminal actually fills that history.

const patches = [
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/ui_app.zig",
    marker: "// Docyrus: the wire's positive delta_y scrolls toward later content",
    original:
      "            if (self.terminal_sessions.wheel(node.widget.terminal.pty, input_event.delta_y)) {",
    replacement: `            // Docyrus: the wire's positive delta_y scrolls toward later content
            // (the convention every scroll region consumes), but the terminal
            // store reads a positive delta as "reveal history". Negate at the
            // seam so scrolling up walks the scrollback instead of no-oping
            // against the pinned live screen.
            if (self.terminal_sessions.wheel(node.widget.terminal.pty, -input_event.delta_y)) {`,
    error:
      "The installed Native SDK terminal wheel seam changed; update the Docyrus terminal-scrollback patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "// Docyrus raised this so a resumed agent session scrolls back to its start.",
    original: "                .max_scrollback = 1_000_000,",
    replacement: `                // Docyrus raised this so a resumed agent session scrolls back to its start.
                .max_scrollback = 10_000_000,`,
    error:
      "The installed Native SDK terminal scrollback limit changed; update the Docyrus terminal-scrollback patch before building.",
  },
];

for (const patch of patches) {
  const target = fileURLToPath(new URL(patch.file, import.meta.url));
  const source = readFileSync(target, "utf8");
  if (source.includes(patch.marker)) continue;
  if (!source.includes(patch.original)) throw new Error(patch.error);
  writeFileSync(target, source.replace(patch.original, patch.replacement));
}
