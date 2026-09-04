import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Three fixes to terminal wheel handling, all hit while scrolling through a
// `claude` session in a terminal pane.
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
//
// 3. CHILD-OWNED WHEEL. The store had no mouse reporting at all: every wheel
//    scrolled the local scrollback. A full-screen TUI (Claude Code's
//    `"tui": "fullscreen"`) switches to the alternate screen and enables SGR
//    mouse tracking (?1049h ?1000h ?1002h ?1003h ?1006h), then scrolls its own
//    view from the button-4/5 reports every terminal sends it -- ours sent
//    nothing and scrolled an alternate screen with no history. Mirror the rule
//    ghostty's Surface applies: with tracking on, each wheel row becomes a
//    press report in the negotiated format; on the alternate screen without
//    tracking (alternate-scroll mode, on by default), it becomes cursor keys;
//    otherwise the scrollback keeps the wheel. The emulator already tracks
//    `flags.mouse_event` / `mouse_format` and the active screen through
//    ghostty's own TerminalStream handler, so the store only has to consult
//    them.

const seamOriginal =
  "            if (!self.terminal_sessions.hasSession(node.widget.terminal.pty)) return false;\n" +
  "            if (self.terminal_sessions.wheel(node.widget.terminal.pty, input_event.delta_y)) {";
// The earlier revision of this patch (direction only): upgraded in place.
const seamPrevious =
  "            if (!self.terminal_sessions.hasSession(node.widget.terminal.pty)) return false;\n" +
  "            // Docyrus: the wire's positive delta_y scrolls toward later content\n" +
  "            // (the convention every scroll region consumes), but the terminal\n" +
  "            // store reads a positive delta as \"reveal history\". Negate at the\n" +
  "            // seam so scrolling up walks the scrollback instead of no-oping\n" +
  "            // against the pinned live screen.\n" +
  "            if (self.terminal_sessions.wheel(node.widget.terminal.pty, -input_event.delta_y)) {";
const seamReplacement = `            if (!self.terminal_sessions.hasSession(node.widget.terminal.pty)) return false;
            // Docyrus: the wire's positive delta_y scrolls toward later content
            // (the convention every scroll region consumes), but the terminal
            // store reads a positive delta as "reveal history". Negate at the
            // seam so scrolling up walks the scrollback instead of no-oping
            // against the pinned live screen.
            const wheel_delta = -input_event.delta_y;
            // Docyrus: the child owns the wheel under mouse tracking or on the
            // alternate screen (a full-screen TUI scrolls its own view). The
            // pointer translates into the same padded content box the
            // selection path uses, so a report names the cell under it.
            {
                const frame = node.frame.normalized();
                const padding = node.widget.layout.padding;
                const declared = padding.left + padding.top + padding.right + padding.bottom > 0;
                const inset: geometry.InsetsF = if (declared) padding else geometry.InsetsF.all(8);
                if (self.terminal_sessions.wheelToChild(node.widget.terminal.pty, wheel_delta, .{
                    .x = point.x - (frame.x + inset.left),
                    .y = point.y - (frame.y + inset.top),
                    .shift = input_event.modifiers.shift,
                    .alt = input_event.modifiers.option,
                    .ctrl = input_event.modifiers.control,
                })) return true;
            }
            if (self.terminal_sessions.wheel(node.widget.terminal.pty, wheel_delta)) {`;

const pointerTypeOriginal = `pub const PointerSelectionResult = struct {
    changed: bool = false,
    selection_active: bool = false,
};`;
const pointerTypeReplacement = `${pointerTypeOriginal}

/// Docyrus: the pointer half of a wheel over a bound terminal, in the
/// terminal's padded content box, for the child-owned wheel paths (a
/// mouse report names the cell under the pointer).
pub const WheelPointer = struct {
    x: f32 = 0,
    y: f32 = 0,
    shift: bool = false,
    alt: bool = false,
    ctrl: bool = false,
};`;

const stubOriginal = "    pub fn pointerSelection(self: *DisabledStore, pty: u64, event: PointerSelectionEvent) PointerSelectionResult {";
const stubReplacement = `    pub fn wheelToChild(self: *DisabledStore, pty: u64, delta_y: f32, pointer: WheelPointer) bool {
        _ = self;
        _ = pty;
        _ = delta_y;
        _ = pointer;
        return false;
    }
${stubOriginal}`;

const storeOriginal = "    /// Primary-pointer terminal selection. The emulator owns the";
const storeReplacement = `    /// Docyrus: a wheel the CHILD owns rather than the scrollback — the
    /// rule every terminal applies. With mouse tracking on, each row of
    /// wheel becomes a button-4/5 press report in the negotiated format
    /// (a full-screen TUI scrolls its own view from those); on the
    /// alternate screen with alternate-scroll mode and no tracking, it
    /// becomes cursor up/down keys. \`delta_y\` follows \`wheel\`'s
    /// convention (positive reveals history, i.e. wheel UP) and shares
    /// its row accumulator. Returns whether the child took the gesture;
    /// when it did the viewport stays put and nothing else consumes it.
    pub fn wheelToChild(self: *EnabledStore, pty: u64, delta_y: f32, pointer: WheelPointer) bool {
        const session = self.find(pty) orelse return false;
        if (!session.acceptsInput()) return false;
        const tracking = session.term.flags.mouse_event != .none;
        const alternate_scroll = session.term.screens.active_key == .alternate and
            session.term.modes.get(.mouse_alternate_scroll);
        if (!tracking and !alternate_scroll) return false;
        session.wheel_accum += delta_y;
        const cell_h = @max(1, session.cell_height);
        const rows = @trunc(session.wheel_accum / cell_h);
        if (rows == 0) return true;
        session.wheel_accum -= rows * cell_h;
        session.clearSelectionForInput();
        const up = rows > 0;
        const count: usize = @intFromFloat(@abs(rows));
        if (!tracking) {
            const sequence: []const u8 = if (session.term.modes.get(.cursor_keys))
                (if (up) "\\x1bOA" else "\\x1bOB")
            else
                (if (up) "\\x1b[A" else "\\x1b[B");
            for (0..count) |_| session.enqueueTransient(self.gateway, pty, sequence);
            return true;
        }
        // X10 tracking reports only left/middle/right presses: the wheel
        // is captured, nothing is sent.
        if (session.term.flags.mouse_event == .x10) return true;
        var code: u32 = if (up) 64 else 65;
        if (pointer.shift) code += 4;
        if (pointer.alt) code += 8;
        if (pointer.ctrl) code += 16;
        const cols_count = session.cols();
        const rows_count = session.rows();
        if (cols_count == 0 or rows_count == 0) return true;
        const cell_w = @max(1, session.cell_width);
        const max_x: f32 = @floatFromInt(cols_count - 1);
        const max_y: f32 = @floatFromInt(rows_count - 1);
        const cell_x: u32 = @intFromFloat(std.math.clamp(@floor(pointer.x / cell_w), 0, max_x));
        const cell_y: u32 = @intFromFloat(std.math.clamp(@floor(pointer.y / cell_h), 0, max_y));
        var buffer: [48]u8 = undefined;
        const report: []const u8 = switch (session.term.flags.mouse_format) {
            .x10 => x10: {
                if (cell_x > 222 or cell_y > 222) return true;
                buffer[0..3].* = "\\x1b[M".*;
                buffer[3] = @intCast(32 + code);
                buffer[4] = @intCast(32 + cell_x + 1);
                buffer[5] = @intCast(32 + cell_y + 1);
                break :x10 buffer[0..6];
            },
            .utf8 => utf8: {
                buffer[0..3].* = "\\x1b[M".*;
                buffer[3] = @intCast(32 + code);
                var len: usize = 4;
                len += std.unicode.utf8Encode(@intCast(cell_x + 33), buffer[len..]) catch return true;
                len += std.unicode.utf8Encode(@intCast(cell_y + 33), buffer[len..]) catch return true;
                break :utf8 buffer[0..len];
            },
            .sgr => std.fmt.bufPrint(&buffer, "\\x1b[<{d};{d};{d}M", .{ code, cell_x + 1, cell_y + 1 }) catch return true,
            .urxvt => std.fmt.bufPrint(&buffer, "\\x1b[{d};{d};{d}M", .{ 32 + code, cell_x + 1, cell_y + 1 }) catch return true,
            .sgr_pixels => std.fmt.bufPrint(&buffer, "\\x1b[<{d};{d};{d}M", .{
                code,
                @as(u32, @intFromFloat(@max(0, @round(pointer.x)))),
                @as(u32, @intFromFloat(@max(0, @round(pointer.y)))),
            }) catch return true,
        };
        for (0..count) |_| session.enqueueTransient(self.gateway, pty, report);
        return true;
    }

${storeOriginal}`;

const testsMarker = "// Docyrus: the child-owned wheel (mouse reports, alternate scroll).";
const testsAppend = `
${testsMarker}

test "docyrus: wheel under mouse tracking reports button 4/5 presses and leaves the viewport alone" {
    if (comptime !terminal_session.enabled) return error.SkipZigTest;
    var store = TerminalSessions.init(testing.allocator);
    defer store.deinit();
    var gw = TestGateway{ .gpa = testing.allocator };
    defer gw.deinit();
    store.setGateway(gw.gateway());
    store.beginBuild(.{});
    _ = store.reconcile(5, 0, 20, 4) orelse return error.TestExpectedState;
    var line: [16]u8 = undefined;
    for (0..30) |index| {
        feedOutput(&store, 5, std.fmt.bufPrint(&line, "line {d}\\r\\n", .{index}) catch unreachable);
    }

    // Primary screen, no tracking: the scrollback owns the wheel.
    try testing.expect(!store.wheelToChild(5, 18, .{}));
    try testing.expectEqualStrings("", gw.written.items);

    // A full-screen TUI: alternate screen + SGR any-motion tracking.
    feedOutput(&store, 5, "\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h");
    // Two rows of wheel UP over cell (3, 1): two 1-based button-4 presses.
    try testing.expect(store.wheelToChild(5, 18 * 2, .{ .x = 8 * 3, .y = 18 }));
    try testing.expectEqualStrings("\\x1b[<64;4;2M\\x1b[<64;4;2M", gw.written.items);
    gw.written.clearRetainingCapacity();
    // Wheel DOWN with shift: button 5 + the shift bit.
    try testing.expect(store.wheelToChild(5, -18, .{ .shift = true }));
    try testing.expectEqualStrings("\\x1b[<69;1;1M", gw.written.items);
    gw.written.clearRetainingCapacity();
    // Sub-row deltas accumulate: captured, nothing sent yet.
    try testing.expect(store.wheelToChild(5, 6, .{}));
    try testing.expectEqualStrings("", gw.written.items);
    try testing.expectEqual(@as(u32, 0), (store.currentState(5) orelse return error.TestExpectedState).scrollback);

    // Legacy X10 format on the same tracking mode.
    feedOutput(&store, 5, "\\x1b[?1006l");
    try testing.expect(store.wheelToChild(5, 12, .{}));
    try testing.expectEqualStrings("\\x1b[M\\x60!!", gw.written.items);
    gw.written.clearRetainingCapacity();

    // Tracking off again, still on the alternate screen: cursor keys.
    feedOutput(&store, 5, "\\x1b[?1003l\\x1b[?1002l\\x1b[?1000l");
    try testing.expect(store.wheelToChild(5, 18, .{}));
    try testing.expectEqualStrings("\\x1b[A", gw.written.items);
    gw.written.clearRetainingCapacity();
    feedOutput(&store, 5, "\\x1b[?1h");
    try testing.expect(store.wheelToChild(5, -18 * 2, .{}));
    try testing.expectEqualStrings("\\x1bOB\\x1bOB", gw.written.items);
    gw.written.clearRetainingCapacity();

    // Back on the primary screen the scrollback owns it again.
    feedOutput(&store, 5, "\\x1b[?1049l");
    try testing.expect(!store.wheelToChild(5, 18, .{}));
    try testing.expectEqualStrings("", gw.written.items);
    try testing.expect(store.wheel(5, 18));
    try testing.expectEqual(@as(u32, 1), (store.currentState(5) orelse return error.TestExpectedState).scrollback);
}
`;

const patches = [
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/ui_app.zig",
    marker: "// Docyrus: the child owns the wheel under mouse tracking",
    originals: [seamPrevious, seamOriginal],
    replacement: seamReplacement,
    error: "The installed Native SDK terminal wheel seam changed; update the Docyrus terminal-scrollback patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "// Docyrus raised this so a resumed agent session scrolls back to its start.",
    originals: ["                .max_scrollback = 1_000_000,"],
    replacement: `                // Docyrus raised this so a resumed agent session scrolls back to its start.
                .max_scrollback = 10_000_000,`,
    error: "The installed Native SDK terminal scrollback limit changed; update the Docyrus terminal-scrollback patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "pub const WheelPointer = struct {",
    originals: [pointerTypeOriginal],
    replacement: pointerTypeReplacement,
    error: "The installed Native SDK terminal pointer types changed; update the Docyrus terminal-scrollback patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "pub fn wheelToChild(self: *DisabledStore",
    originals: [stubOriginal],
    replacement: stubReplacement,
    error: "The installed Native SDK terminal stub store changed; update the Docyrus terminal-scrollback patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "pub fn wheelToChild(self: *EnabledStore",
    originals: [storeOriginal],
    replacement: storeReplacement,
    error: "The installed Native SDK terminal session store changed; update the Docyrus terminal-scrollback patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session_tests.zig",
    marker: testsMarker,
    originals: [],
    append: testsAppend,
  },
];

for (const patch of patches) {
  const target = fileURLToPath(new URL(patch.file, import.meta.url));
  const source = readFileSync(target, "utf8");
  if (source.includes(patch.marker)) continue;
  if (patch.append !== undefined) {
    writeFileSync(target, source + patch.append);
    continue;
  }
  const original = patch.originals.find((candidate) => source.includes(candidate));
  if (original === undefined) throw new Error(patch.error);
  writeFileSync(target, source.replace(original, patch.replacement));
}
