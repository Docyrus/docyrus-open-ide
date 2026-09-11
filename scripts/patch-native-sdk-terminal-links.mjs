import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Clickable links in a terminal pane.
//
// The SDK's `<terminal>` is an emulator viewport and nothing else: it reports
// scrollback geometry through `on-terminal` and owns pointer SELECTION, but a
// URL or a file path in the output is just characters. This patch adds the two
// halves an IDE needs and keeps both framework-side, where the emulator's cell
// state lives:
//
// 1. HOVER. The pointer's position inside the terminal's padded content box is
//    stored on the session (the POINT, never the resolved range -- output and
//    scrolling move text under a still pointer, so the link re-resolves on
//    every snapshot). The token under it, when it reads as a link, paints
//    underlined through the cell state the grid painter already honours.
//
// 2. ACTIVATION. A Command-click arms the token under the press and opens it on
//    release, but only when the release lands back on the same token, so a
//    Command-drag ends in nothing rather than an unasked-for open. The
//    activation rides `canvas.TerminalState` -- the payload `on-terminal`
//    already delivers -- as a monotonic `link_seq` plus the target bytes, so no
//    new element attribute, handler table, or Msg plumbing is needed. A click
//    that presses nothing triggers no rebuild to reconcile the state out of, so
//    the pointer path dispatches the Msg itself, exactly as the rebuild tail's
//    drain does.
//
// Classification stays here too, because the hover underline needs it a frame
// before any app sees the token: `http(s)://` and `www.` are urls, and a token
// with a path separator (or a bare filename with a real extension) is a path,
// with a trailing `:line` / `:line:col` split off into `link_line`. The APP
// still owns policy -- which pane a file opens in, how a relative path resolves,
// whether the file exists at all.

const gridStateOriginal = `    /// The live grid the layout derived, in cells — what the pty was
    /// last resized to.
    cols: u16 = 0,
    rows: u16 = 0,
};`;
const gridStateReplacement = `    /// The live grid the layout derived, in cells — what the pty was
    /// last resized to.
    cols: u16 = 0,
    rows: u16 = 0,

    // Docyrus: the clicked-link channel.
    //
    /// Monotonic activation counter. Every activated link bumps it,
    /// which is what makes the state compare unequal and therefore
    /// dispatch; the app acts only when the number it last saw moved,
    /// so the ordinary scroll reports that follow carry the same
    /// activation without opening it twice.
    link_seq: u32 = 0,
    /// What the last activation named — \`none\` until the first one.
    link_kind: TerminalLinkKind = .none,
    /// The 1-based line a \`path:42\` or \`path:42:9\` suffix named; 0
    /// when the token carried none.
    link_line: u32 = 0,
    link_len: u16 = 0,
    link_bytes: [max_link_bytes]u8 = @splat(0),

    /// The activated link's target: the clicked token with any
    /// \`:line:col\` suffix already split off.
    pub fn linkTarget(self: *const TerminalState) []const u8 {
        return self.link_bytes[0..@min(self.link_len, max_link_bytes)];
    }
};`;

const gridKindMarker = "pub const TerminalLinkKind = enum(u8) { none, url, path };";
const gridKindOriginal = `/// The app-visible terminal view state: the payload \`on-terminal\``;
const gridKindReplacement = `/// Docyrus: what a terminal link activation named. \`url\` is an
/// http(s) or \`www.\` token the app hands to the system browser;
/// \`path\` is a filesystem-shaped token the app opens itself.
pub const TerminalLinkKind = enum(u8) { none, url, path };

/// Docyrus: the byte ceiling on one reported link target. A longer
/// token is not reported at all rather than truncated, which would
/// name a different file.
pub const max_link_bytes: usize = 512;

${gridKindOriginal}`;

const rootExportOriginal = "pub const TerminalState = terminal_grid.TerminalState;";
const rootExportReplacement = `pub const TerminalState = terminal_grid.TerminalState;
// Docyrus: the clicked-link channel on TerminalState.
pub const TerminalLinkKind = terminal_grid.TerminalLinkKind;
pub const max_terminal_link_bytes = terminal_grid.max_link_bytes;`;

// ---------------------------------------------------------------- session

const pointerEventOriginal = `pub const PointerSelectionEvent = struct {
    phase: canvas.WidgetPointerPhase,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    click_count: u8 = 1,
};

pub const PointerSelectionResult = struct {
    changed: bool = false,
    selection_active: bool = false,
};`;
const pointerEventReplacement = `pub const PointerSelectionEvent = struct {
    phase: canvas.WidgetPointerPhase,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    click_count: u8 = 1,
    /// Docyrus: the platform's "activate rather than select" modifier
    /// (Command on macOS) was held for this event.
    command: bool = false,
};

pub const PointerSelectionResult = struct {
    changed: bool = false,
    selection_active: bool = false,
    /// Docyrus: this release opened a link — the session recorded the
    /// target and the caller owes its \`on-terminal\` a dispatch.
    link_activated: bool = false,
};

// ------------------------------------------------- Docyrus: link scanning

/// One link-shaped token found on a terminal row, in viewport columns.
pub const TerminalLinkSpan = struct {
    /// First column and one-past-last column of the WHOLE token,
    /// suffix included — the range the hover underline paints.
    start: u16,
    end: u16,
    /// One-past-last column of the TARGET: the token with any
    /// \`:line:col\` suffix removed.
    target_end: u16,
    kind: canvas.TerminalLinkKind,
    line: u32 = 0,
};

/// Bytes a link token may be built from. Deliberately narrower than
/// the URL grammar: parentheses, quotes, and brackets are what
/// terminal output WRAPS links in, so treating them as boundaries is
/// what makes \`(see src/main.zig)\` resolve to the path.
fn isLinkByte(byte: u8) bool {
    return switch (byte) {
        'A'...'Z', 'a'...'z', '0'...'9' => true,
        '-', '.', '_', '~', ':', '/', '?', '#', '@', '!', '$', '&', '*', '+', ',', ';', '=', '%', '\\\\' => true,
        else => false,
    };
}

/// Sentence punctuation a token can merely END on: the period of
/// "see src/main.zig." is prose, not part of the path.
fn isTrailingPunctuation(byte: u8) bool {
    return switch (byte) {
        '.', ',', ';', ':', '!', '?' => true,
        else => false,
    };
}

/// Punctuation no link STARTS with. \`.\`, \`/\`, \`~\`, and \`-\` are
/// absent on purpose — \`./build.zig\`, \`/etc/hosts\`, and \`~/.zshrc\`
/// all open on their first byte.
fn isLeadingPunctuation(byte: u8) bool {
    return switch (byte) {
        ',', ';', ':', '!', '?', '=', '&', '%', '*', '+', '#', '$', '@' => true,
        else => false,
    };
}

/// Schemes are matched case-sensitively: the runtime's own external-url
/// validation only accepts lowercase \`http://\`/\`https://\`, and real
/// terminal output prints them that way.
fn looksLikeUrl(token: []const u8) bool {
    return std.mem.startsWith(u8, token, "http://") or
        std.mem.startsWith(u8, token, "https://") or
        std.mem.startsWith(u8, token, "www.");
}

/// A token reads as a path when it carries a separator, or when it is
/// a bare filename with a real extension. The extension must hold a
/// letter, which is what keeps \`1.2.3\` and \`192.168.1.10\` out.
fn looksLikePath(token: []const u8) bool {
    if (token.len == 0) return false;
    if (std.mem.indexOf(u8, token, "://") != null) return false;
    if (std.mem.indexOfScalar(u8, token, '/') != null) return true;
    const dot = std.mem.lastIndexOfScalar(u8, token, '.') orelse return false;
    if (dot == 0 or dot + 1 == token.len) return false;
    const extension = token[dot + 1 ..];
    if (extension.len > 10) return false;
    var has_letter = false;
    for (extension) |byte| {
        if (std.ascii.isAlphabetic(byte)) {
            has_letter = true;
        } else if (!std.ascii.isDigit(byte)) return false;
    }
    return has_letter;
}

const DigitSuffix = struct { head_len: usize, value: u32 };

/// Split one trailing \`:<digits>\` group: \`src/main.zig:42\` answers
/// head "src/main.zig" and 42. Null when the token does not end in
/// one, or when the digits are the whole token.
fn splitDigitSuffix(token: []const u8) ?DigitSuffix {
    if (token.len == 0) return null;
    var index = token.len;
    while (index > 0 and std.ascii.isDigit(token[index - 1])) index -= 1;
    if (index == token.len or index == 0) return null;
    if (token[index - 1] != ':') return null;
    const digits = token[index..];
    if (digits.len > 9) return null;
    return .{
        .head_len = index - 1,
        .value = std.fmt.parseInt(u32, digits, 10) catch return null,
    };
}

/// The link token covering \`column\` on one row of ASCII cells, or
/// null when that column is not on one. Trimming can pull the span off
/// the clicked column (clicking the period after a path); that reads
/// as "no link here" rather than as the neighbouring token.
pub fn linkSpanAt(row: []const u8, column: u16) ?TerminalLinkSpan {
    if (column >= row.len or !isLinkByte(row[column])) return null;
    var start: usize = column;
    while (start > 0 and isLinkByte(row[start - 1])) start -= 1;
    var end: usize = @as(usize, column) + 1;
    while (end < row.len and isLinkByte(row[end])) end += 1;
    while (end > start and isTrailingPunctuation(row[end - 1])) end -= 1;
    while (start < end and isLeadingPunctuation(row[start])) start += 1;
    if (start > column or end <= column) return null;

    const token = row[start..end];
    if (looksLikeUrl(token)) return .{
        .start = @intCast(start),
        .end = @intCast(end),
        .target_end = @intCast(end),
        .kind = .url,
    };

    // \`file:42\` is a line; \`file:42:9\` is a line and a column, and the
    // LEFT number is the line either way.
    var target_len = token.len;
    var line: u32 = 0;
    if (splitDigitSuffix(token)) |first| {
        if (splitDigitSuffix(token[0..first.head_len])) |second| {
            target_len = second.head_len;
            line = second.value;
        } else {
            target_len = first.head_len;
            line = first.value;
        }
    }
    if (!looksLikePath(token[0..target_len])) return null;
    return .{
        .start = @intCast(start),
        .end = @intCast(end),
        .target_end = @intCast(start + target_len),
        .kind = .path,
        .line = line,
    };
}

/// One viewport row as ASCII columns for the scanner. An empty or
/// non-ASCII cell becomes a space, so a column index IS a byte index
/// and a multi-byte glyph reads as a token boundary — links in
/// terminal output are ASCII.
fn rowLinkBytes(cells: []const canvas.TerminalCell, out: []u8) []const u8 {
    const count = @min(cells.len, out.len);
    for (cells[0..count], out[0..count]) |cell, *byte| {
        byte.* = if (cell.cp == 0 or cell.cp > 127) ' ' else @intCast(cell.cp);
    }
    return out[0..count];
}`;

const stubHoverOriginal = "    pub fn pointerSelection(self: *DisabledStore, pty: u64, event: PointerSelectionEvent) PointerSelectionResult {";
const stubHoverReplacement = `    pub fn setHover(self: *DisabledStore, pty: u64, x: f32, y: f32, active: bool) bool {
        _ = self;
        _ = pty;
        _ = x;
        _ = y;
        _ = active;
        return false;
    }
${stubHoverOriginal}`;

const storeHoverOriginal = `    /// Primary-pointer terminal selection. The emulator owns the`;
const storeHoverReplacement = `    /// Docyrus: where the pointer sits over a terminal, in that
    /// terminal's padded content box. Every OTHER session's hover
    /// clears, so moving off a terminal drops its underline. Returns
    /// whether any session's hovered link moved — the caller's repaint
    /// trigger, and deliberately NOT "the pointer moved": sweeping
    /// across plain output resolves no link and rebuilds nothing.
    pub fn setHover(self: *EnabledStore, pty: u64, x: f32, y: f32, active: bool) bool {
        var changed = false;
        for (&self.entries) |*entry| {
            const session = entry.session orelse continue;
            if (!active or pty == 0 or entry.key != pty) {
                if (!session.hover_active) continue;
                session.hover_active = false;
                if (session.clearHoverLink()) {
                    session.snapshot_dirty = true;
                    changed = true;
                }
                continue;
            }
            if (session.hover_active and session.hover_x == x and session.hover_y == y) continue;
            session.hover_active = true;
            session.hover_x = x;
            session.hover_y = y;
            if (session.refreshHoverLink()) {
                session.snapshot_dirty = true;
                changed = true;
            }
        }
        return changed;
    }

${storeHoverOriginal}`;

const sessionFieldsOriginal = `    /// View state for the source-wins scrollback echo and the
    /// \`on-terminal\` change compare.
    last_bound_scrollback: u32 = 0,
    last_reported: ?canvas.TerminalState = null,
    wheel_accum: f32 = 0,`;
const sessionFieldsReplacement = `    /// View state for the source-wins scrollback echo and the
    /// \`on-terminal\` change compare.
    last_bound_scrollback: u32 = 0,
    last_reported: ?canvas.TerminalState = null,
    wheel_accum: f32 = 0,

    // Docyrus: clickable links.
    //
    /// The pointer inside the padded content box while it hovers this
    /// terminal. The POINT is what is stored, never the range it
    /// resolved to: output and scrolling move text under a still
    /// pointer, so the link re-resolves on every snapshot.
    hover_active: bool = false,
    hover_x: f32 = 0,
    hover_y: f32 = 0,
    /// The link the last resolve found under that point, in viewport
    /// cells — the underline the next snapshot paints.
    hover_link_active: bool = false,
    hover_link_row: u16 = 0,
    hover_link_start: u16 = 0,
    hover_link_end: u16 = 0,
    /// The link a Command-press armed, so the release only opens when
    /// it lands back on the same token.
    link_press_active: bool = false,
    link_press_row: u16 = 0,
    link_press_start: u16 = 0,
    link_press_end: u16 = 0,
    /// The last activation, published through \`canvas.TerminalState\`.
    link_seq: u32 = 0,
    link_kind: canvas.TerminalLinkKind = .none,
    link_line: u32 = 0,
    link_len: u16 = 0,
    link_bytes: [canvas.max_terminal_link_bytes]u8 = @splat(0),`;

const sessionPointerOriginal = `    fn pointerSelection(session: *Session, event: PointerSelectionEvent) PointerSelectionResult {
        if (!std.math.isFinite(event.x) or !std.math.isFinite(event.y) or`;
const sessionPointerReplacement = `    /// Docyrus: the link under a point in the padded content box, read
    /// off the PUBLISHED snapshot — what the user is looking at is what
    /// a click names.
    fn linkAtPoint(session: *Session, x: f32, y: f32) ?HoveredLink {
        if (session.cell_width <= 0 or session.cell_height <= 0) return null;
        if (!std.math.isFinite(x) or !std.math.isFinite(y) or x < 0 or y < 0) return null;
        // Both cell indices are range-checked as FLOATS: a pointer far
        // past the grid (a captured drag beyond the window) would make
        // the narrowing itself illegal, not merely out of bounds.
        const row_f = @floor(y / session.cell_height);
        if (row_f >= @as(f32, @floatFromInt(session.grid.rows.len))) return null;
        const row_index: usize = @intFromFloat(row_f);
        const column_f = @floor(x / session.cell_width);
        if (column_f >= @as(f32, @floatFromInt(canvas.max_terminal_cols))) return null;
        var buffer: [canvas.max_terminal_cols]u8 = undefined;
        const row = rowLinkBytes(session.grid.rows[row_index].cells, &buffer);
        const span = linkSpanAt(row, @intFromFloat(column_f)) orelse return null;
        return .{ .row = @intCast(row_index), .span = span };
    }

    /// Re-resolve the hovered link from the published snapshot.
    /// Returns whether the underlined range moved.
    fn refreshHoverLink(session: *Session) bool {
        if (!session.hover_active) return session.clearHoverLink();
        const hit = session.linkAtPoint(session.hover_x, session.hover_y) orelse return session.clearHoverLink();
        if (session.hover_link_active and
            session.hover_link_row == hit.row and
            session.hover_link_start == hit.span.start and
            session.hover_link_end == hit.span.end) return false;
        session.hover_link_active = true;
        session.hover_link_row = hit.row;
        session.hover_link_start = hit.span.start;
        session.hover_link_end = hit.span.end;
        return true;
    }

    fn clearHoverLink(session: *Session) bool {
        if (!session.hover_link_active) return false;
        session.hover_link_active = false;
        return true;
    }

    /// Store an activation for the next \`canvas.TerminalState\`.
    /// A target past the report ceiling is dropped WHOLE — a truncated
    /// path names a different file.
    fn recordLink(session: *Session, target: []const u8, span: TerminalLinkSpan) bool {
        if (target.len == 0 or target.len > session.link_bytes.len) return false;
        @memcpy(session.link_bytes[0..target.len], target);
        session.link_len = @intCast(target.len);
        session.link_kind = span.kind;
        session.link_line = span.line;
        session.link_seq +%= 1;
        return true;
    }

    /// Docyrus: the Command-click gesture, ahead of the selection
    /// gesture it replaces. Returns the result to answer with, or null
    /// to let selection take the event (a Command-click on plain output
    /// is still an ordinary click).
    fn linkGesture(session: *Session, event: PointerSelectionEvent) ?PointerSelectionResult {
        if (!event.command) {
            session.link_press_active = false;
            return null;
        }
        switch (event.phase) {
            .down => {
                const hit = session.linkAtPoint(event.x, event.y) orelse {
                    session.link_press_active = false;
                    return null;
                };
                session.link_press_active = true;
                session.link_press_row = hit.row;
                session.link_press_start = hit.span.start;
                session.link_press_end = hit.span.end;
                return .{};
            },
            .move => return if (session.link_press_active) .{} else null,
            .up => {
                if (!session.link_press_active) return null;
                session.link_press_active = false;
                const hit = session.linkAtPoint(event.x, event.y) orelse return .{};
                if (hit.row != session.link_press_row or
                    hit.span.start != session.link_press_start or
                    hit.span.end != session.link_press_end) return .{};
                var buffer: [canvas.max_terminal_cols]u8 = undefined;
                const row = rowLinkBytes(session.grid.rows[hit.row].cells, &buffer);
                const target = row[hit.span.start..hit.span.target_end];
                return .{ .link_activated = session.recordLink(target, hit.span) };
            },
            .cancel => {
                session.link_press_active = false;
                return null;
            },
            .hover, .wheel => return null,
        }
    }

    fn pointerSelection(session: *Session, event: PointerSelectionEvent) PointerSelectionResult {
        if (session.linkGesture(event)) |result| return result;
        if (!std.math.isFinite(event.x) or !std.math.isFinite(event.y) or`;

const sessionHoveredLinkOriginal = `    /// Default terminal word boundaries, matching Ghostty's standard`;
const sessionHoveredLinkReplacement = `    /// Docyrus: a resolved link plus the viewport row it sits on.
    const HoveredLink = struct { row: u16, span: TerminalLinkSpan };

${sessionHoveredLinkOriginal}`;

const snapshotUnderlineOriginal = `            session.rows_buf[y] = .{
                .cells = session.cells_buf[row_start..cell_index],`;
const snapshotUnderlineReplacement = `            // Docyrus: the hovered link's underline, painted through the
            // cell state the grid painter already honours.
            if (session.hover_link_active and session.hover_link_row == y) {
                const row_cells = session.cells_buf[row_start..cell_index];
                const underline_end = @min(session.hover_link_end, row_cells.len);
                if (session.hover_link_start < underline_end) {
                    for (row_cells[session.hover_link_start..underline_end]) |*cell| cell.underline = true;
                }
            }
            session.rows_buf[y] = .{
                .cells = session.cells_buf[row_start..cell_index],`;

const snapshotTailOriginal = `        session.snapshot_dirty = false;
    }`;
const snapshotTailReplacement = `        session.snapshot_dirty = false;
        // Docyrus: the pointer has not moved but the text under it may
        // have (output, a scroll). Re-resolving against the snapshot
        // just published re-dirties it for one more frame when the
        // underline actually belongs somewhere else now.
        if (session.refreshHoverLink()) session.snapshot_dirty = true;
    }`;

const stateOriginal = `        return .{
            .scrollback = @intCast(history -| @as(u32, @intCast(bar.offset))),
            .history = history,
            .cols = session.cols(),
            .rows = session.rows(),
        };`;
const stateReplacement = `        return .{
            .scrollback = @intCast(history -| @as(u32, @intCast(bar.offset))),
            .history = history,
            .cols = session.cols(),
            .rows = session.rows(),
            // Docyrus: the clicked-link channel rides the same payload.
            .link_seq = session.link_seq,
            .link_kind = session.link_kind,
            .link_line = session.link_line,
            .link_len = session.link_len,
            .link_bytes = session.link_bytes,
        };`;

const stateEqlOriginal = `        return a.scrollback == b.scrollback and a.history == b.history and
            a.cols == b.cols and a.rows == b.rows;`;
const stateEqlReplacement = `        return a.scrollback == b.scrollback and a.history == b.history and
            a.cols == b.cols and a.rows == b.rows and
            // Docyrus: an activation is a CHANGE, which is what makes
            // the state dispatch; the target bytes ride along with it.
            a.link_seq == b.link_seq;`;

// ----------------------------------------------------------------- ui_app

const uiPointerOriginal = `        /// Route primary pointer selection into a bound terminal before
        /// ordinary press dispatch. The layout query supplies the
        /// terminal's resolved frame; coordinates are translated into
        /// the same padded content box the painter and size reconcile
        /// use, then Ghostty owns cell snapping and tracked selection
        /// pins. Returns whether an active selection should suppress a
        /// release-time \`on_press\`.
        fn handleTerminalPointer(self: *Self, runtime: *Runtime, pointer_event: core.CanvasWidgetPointerEvent) anyerror!bool {
            if (comptime !terminal_session.enabled) return false;
            switch (pointer_event.pointer.phase) {
                .down, .move, .up, .cancel => {},
                .hover, .wheel => return false,
            }
            if (pointer_event.pointer.phase == .down and pointer_event.pointer.button != 0) return false;
            const target = pointer_event.target orelse return false;
            const layout = runtime.canvasWidgetLayout(pointer_event.window_id, pointer_event.view_label) catch return false;
            var terminal_node: ?canvas.WidgetLayoutNode = null;
            for (layout.nodes) |node| {
                if (node.widget.id != target.id) continue;
                if (node.widget.kind != .terminal or node.widget.terminal.pty == 0) return false;
                terminal_node = node;
                break;
            }
            const node = terminal_node orelse return false;
            if (!self.terminal_sessions.hasSession(node.widget.terminal.pty)) return false;

            const frame = node.frame.normalized();
            const padding = node.widget.layout.padding;
            const declared = padding.left + padding.top + padding.right + padding.bottom > 0;
            const inset: geometry.InsetsF = if (declared) padding else geometry.InsetsF.all(8);
            const content = geometry.RectF.init(
                frame.x + inset.left,
                frame.y + inset.top,
                @max(0, frame.width - inset.left - inset.right),
                @max(0, frame.height - inset.top - inset.bottom),
            );
            if (content.isEmpty()) return false;
            const result = self.terminal_sessions.pointerSelection(node.widget.terminal.pty, .{
                .phase = pointer_event.pointer.phase,
                .x = pointer_event.pointer.point.x - content.x,
                .y = pointer_event.pointer.point.y - content.y,
                .width = content.width,
                .height = content.height,
                .click_count = pointer_event.pointer.click_count,
            });
            if (result.changed) try self.repaintTerminals(runtime, pointer_event.window_id);
            return pointer_event.pointer.phase == .up and result.selection_active;
        }`;
const uiPointerReplacement = `        /// Docyrus: one bound terminal under the pointer, with the
        /// padded content box the grid's cells actually live in.
        const TerminalPointerHit = struct {
            id: canvas.ObjectId,
            pty: u64,
            content: geometry.RectF,
        };

        fn resolveTerminalPointer(self: *Self, runtime: *Runtime, pointer_event: core.CanvasWidgetPointerEvent) ?TerminalPointerHit {
            const target = pointer_event.target orelse return null;
            // The hit already knows what it is, and hover now runs this on
            // every mouse move across the whole canvas: answer from the hit
            // rather than querying the layout tree for widgets that could
            // never be a terminal.
            if (target.kind != .terminal) return null;
            const layout = runtime.canvasWidgetLayout(pointer_event.window_id, pointer_event.view_label) catch return null;
            for (layout.nodes) |node| {
                if (node.widget.id != target.id) continue;
                if (node.widget.kind != .terminal or node.widget.terminal.pty == 0) return null;
                if (!self.terminal_sessions.hasSession(node.widget.terminal.pty)) return null;
                const frame = node.frame.normalized();
                const padding = node.widget.layout.padding;
                const declared = padding.left + padding.top + padding.right + padding.bottom > 0;
                const inset: geometry.InsetsF = if (declared) padding else geometry.InsetsF.all(8);
                const content = geometry.RectF.init(
                    frame.x + inset.left,
                    frame.y + inset.top,
                    @max(0, frame.width - inset.left - inset.right),
                    @max(0, frame.height - inset.top - inset.bottom),
                );
                if (content.isEmpty()) return null;
                return .{ .id = node.widget.id, .pty = node.widget.terminal.pty, .content = content };
            }
            return null;
        }

        /// Docyrus: deliver a link activation through the widget's
        /// \`on-terminal\` the moment it happens. A click that pressed
        /// nothing dispatches no Msg and therefore triggers no rebuild
        /// for the view-state reconcile to ride, so the pointer path
        /// does what the rebuild tail's drain would have done.
        fn dispatchTerminalLink(self: *Self, runtime: *Runtime, pointer_event: core.CanvasWidgetPointerEvent, hit: TerminalPointerHit) anyerror!void {
            const tree = self.tree orelse return;
            const state = self.terminal_sessions.currentState(hit.pty) orelse return;
            const msg = tree.msgForTerminal(hit.id, state) orelse return;
            try self.dispatch(runtime, pointer_event.window_id, msg);
        }

        /// Route pointer input into a bound terminal before ordinary
        /// press dispatch. The layout query supplies the terminal's
        /// resolved frame; coordinates are translated into the same
        /// padded content box the painter and size reconcile use, then
        /// Ghostty owns cell snapping and tracked selection pins.
        /// Docyrus also routes HOVER here (it drives the link
        /// underline) and lets a Command-click activate a link instead
        /// of selecting. Returns whether an active selection should
        /// suppress a release-time \`on_press\`.
        fn handleTerminalPointer(self: *Self, runtime: *Runtime, pointer_event: core.CanvasWidgetPointerEvent) anyerror!bool {
            if (comptime !terminal_session.enabled) return false;
            switch (pointer_event.pointer.phase) {
                .hover, .down, .move, .up, .cancel => {},
                .wheel => return false,
            }
            const resolved = self.resolveTerminalPointer(runtime, pointer_event);
            // Docyrus: the link underline follows the pointer, and it
            // belongs to whichever terminal the pointer is over —
            // leaving one (or landing on another widget) clears it.
            if (self.terminal_sessions.setHover(
                if (resolved) |hit| hit.pty else 0,
                if (resolved) |hit| pointer_event.pointer.point.x - hit.content.x else 0,
                if (resolved) |hit| pointer_event.pointer.point.y - hit.content.y else 0,
                resolved != null,
            )) try self.repaintTerminals(runtime, pointer_event.window_id);

            const hit = resolved orelse return false;
            if (pointer_event.pointer.phase == .hover) return false;
            if (pointer_event.pointer.phase == .down and pointer_event.pointer.button != 0) return false;
            const result = self.terminal_sessions.pointerSelection(hit.pty, .{
                .phase = pointer_event.pointer.phase,
                .x = pointer_event.pointer.point.x - hit.content.x,
                .y = pointer_event.pointer.point.y - hit.content.y,
                .width = hit.content.width,
                .height = hit.content.height,
                .click_count = pointer_event.pointer.click_count,
                // Command on macOS, the platform's "activate rather
                // than select" modifier. Control stays out of it: on
                // macOS a Control-click is a context-menu click.
                .command = pointer_event.pointer.modifiers.super,
            });
            if (result.changed) try self.repaintTerminals(runtime, pointer_event.window_id);
            if (result.link_activated) try self.dispatchTerminalLink(runtime, pointer_event, hit);
            return pointer_event.pointer.phase == .up and result.selection_active;
        }`;

const testsMarker = "// Docyrus: terminal link scanning, hover underline, and activation.";
const testsAppend = `
${testsMarker}

test "docyrus: the link scanner classifies urls, paths, and line suffixes" {
    const url = terminal_session.linkSpanAt("see https://example.com/a?b=1 now", 10) orelse return error.TestExpectedLink;
    try testing.expectEqual(canvas.TerminalLinkKind.url, url.kind);
    try testing.expectEqualStrings("https://example.com/a?b=1", "see https://example.com/a?b=1 now"[url.start..url.target_end]);

    // Prose punctuation and wrapping parentheses stay out of the token.
    const wrapped = terminal_session.linkSpanAt("(see src/main.zig).", 8) orelse return error.TestExpectedLink;
    try testing.expectEqual(canvas.TerminalLinkKind.path, wrapped.kind);
    try testing.expectEqualStrings("src/main.zig", "(see src/main.zig)."[wrapped.start..wrapped.target_end]);

    // A line, and a line with a column: the LEFT number is the line.
    const at_line = terminal_session.linkSpanAt("src/main.zig:42", 2) orelse return error.TestExpectedLink;
    try testing.expectEqual(@as(u32, 42), at_line.line);
    try testing.expectEqualStrings("src/main.zig", "src/main.zig:42"[at_line.start..at_line.target_end]);
    const at_cell = terminal_session.linkSpanAt("src/main.zig:42:9", 2) orelse return error.TestExpectedLink;
    try testing.expectEqual(@as(u32, 42), at_cell.line);
    try testing.expectEqualStrings("src/main.zig", "src/main.zig:42:9"[at_cell.start..at_cell.target_end]);

    // A bare filename needs a real extension; versions and addresses
    // are not files, and plain words are not links.
    try testing.expect(terminal_session.linkSpanAt("build.zig ok", 0) != null);
    try testing.expect(terminal_session.linkSpanAt("version 1.2.3", 9) == null);
    try testing.expect(terminal_session.linkSpanAt("host 192.168.1.10", 6) == null);
    try testing.expect(terminal_session.linkSpanAt("just some words", 5) == null);
    // Clicking the prose period that trimming removed names nothing.
    try testing.expect(terminal_session.linkSpanAt("see build.zig.", 13) == null);
}

test "docyrus: hovering underlines a link and command-click reports it once" {
    if (comptime !terminal_session.enabled) return error.SkipZigTest;
    var store = TerminalSessions.init(testing.allocator);
    defer store.deinit();
    var gw = TestGateway{ .gpa = testing.allocator };
    defer gw.deinit();
    store.setGateway(gw.gateway());
    store.beginBuild(.{});
    _ = store.reconcile(7, 0, 40, 6) orelse return error.TestExpectedState;
    feedOutput(&store, 7, "open src/main.zig:42 please\\r\\n");
    _ = store.refreshDirty();

    const cell_x = canvas.terminalCellMetrics(.{}).width;
    // Column 8 of row 0 sits inside "src/main.zig:42" (columns 5..19).
    try testing.expect(store.setHover(7, cell_x * 8 + 1, 1, true));
    _ = store.refreshDirty();
    const grid = resolveGrid(&store, 7) orelse return error.TestExpectedGrid;
    try testing.expect(grid.rows[0].cells[5].underline);
    try testing.expect(grid.rows[0].cells[19].underline);
    try testing.expect(!grid.rows[0].cells[21].underline);

    // A plain click still selects; only Command activates.
    const plain = store.pointerSelection(7, .{ .phase = .down, .x = cell_x * 8 + 1, .y = 1, .width = 400, .height = 120 });
    try testing.expect(!plain.link_activated);
    _ = store.pointerSelection(7, .{ .phase = .up, .x = cell_x * 8 + 1, .y = 1, .width = 400, .height = 120 });

    const before = (store.currentState(7) orelse return error.TestExpectedState).link_seq;
    _ = store.pointerSelection(7, .{ .phase = .down, .x = cell_x * 8 + 1, .y = 1, .width = 400, .height = 120, .command = true });
    const activated = store.pointerSelection(7, .{ .phase = .up, .x = cell_x * 8 + 2, .y = 1, .width = 400, .height = 120, .command = true });
    try testing.expect(activated.link_activated);
    const state = store.currentState(7) orelse return error.TestExpectedState;
    try testing.expectEqual(canvas.TerminalLinkKind.path, state.link_kind);
    try testing.expectEqual(@as(u32, 42), state.link_line);
    try testing.expectEqualStrings("src/main.zig", state.linkTarget());
    try testing.expectEqual(before +% 1, state.link_seq);

    // A Command-drag that ends on another token opens nothing.
    _ = store.pointerSelection(7, .{ .phase = .down, .x = cell_x * 8 + 1, .y = 1, .width = 400, .height = 120, .command = true });
    const dragged = store.pointerSelection(7, .{ .phase = .up, .x = cell_x * 24 + 1, .y = 1, .width = 400, .height = 120, .command = true });
    try testing.expect(!dragged.link_activated);
    try testing.expectEqual(state.link_seq, (store.currentState(7) orelse return error.TestExpectedState).link_seq);

    // Moving off the terminal drops the underline.
    try testing.expect(store.setHover(0, 0, 0, false));
    _ = store.refreshDirty();
    const cleared = resolveGrid(&store, 7) orelse return error.TestExpectedGrid;
    try testing.expect(!cleared.rows[0].cells[5].underline);
}
`;

const patches = [
  {
    file: "../node_modules/@native-sdk/cli/src/primitives/canvas/terminal_grid.zig",
    marker: gridKindMarker,
    originals: [gridKindOriginal],
    replacement: gridKindReplacement,
    error: "The installed Native SDK terminal state docs changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/primitives/canvas/terminal_grid.zig",
    marker: "    link_bytes: [max_link_bytes]u8 = @splat(0),",
    originals: [gridStateOriginal],
    replacement: gridStateReplacement,
    error: "The installed Native SDK TerminalState changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/primitives/canvas/root.zig",
    marker: "pub const max_terminal_link_bytes",
    originals: [rootExportOriginal],
    replacement: rootExportReplacement,
    error: "The installed Native SDK canvas exports changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "pub fn linkSpanAt(",
    originals: [pointerEventOriginal],
    replacement: pointerEventReplacement,
    error: "The installed Native SDK terminal pointer event changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "pub fn setHover(self: *DisabledStore",
    originals: [stubHoverOriginal],
    replacement: stubHoverReplacement,
    error: "The installed Native SDK terminal stub store changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "pub fn setHover(self: *EnabledStore",
    originals: [storeHoverOriginal],
    replacement: storeHoverReplacement,
    error: "The installed Native SDK terminal session store changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "    hover_link_active: bool = false,",
    originals: [sessionFieldsOriginal],
    replacement: sessionFieldsReplacement,
    error: "The installed Native SDK terminal session state changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "    const HoveredLink = struct",
    originals: [sessionHoveredLinkOriginal],
    replacement: sessionHoveredLinkReplacement,
    error: "The installed Native SDK terminal word boundaries changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "    fn linkGesture(session: *Session",
    originals: [sessionPointerOriginal],
    replacement: sessionPointerReplacement,
    error: "The installed Native SDK terminal pointer gesture changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "            // Docyrus: the hovered link's underline",
    originals: [snapshotUnderlineOriginal],
    replacement: snapshotUnderlineReplacement,
    error: "The installed Native SDK terminal snapshot rows changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "        if (session.refreshHoverLink()) session.snapshot_dirty = true;",
    originals: [snapshotTailOriginal],
    replacement: snapshotTailReplacement,
    error: "The installed Native SDK terminal snapshot tail changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "            .link_seq = session.link_seq,",
    originals: [stateOriginal],
    replacement: stateReplacement,
    error: "The installed Native SDK terminal view state changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/terminal_session.zig",
    marker: "            a.link_seq == b.link_seq;",
    originals: [stateEqlOriginal],
    replacement: stateEqlReplacement,
    error: "The installed Native SDK terminal state compare changed; update the Docyrus terminal-link patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/runtime/ui_app.zig",
    marker: "        fn resolveTerminalPointer(",
    originals: [uiPointerOriginal],
    replacement: uiPointerReplacement,
    error: "The installed Native SDK terminal pointer seam changed; update the Docyrus terminal-link patch before building.",
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
  // A replacement is literal text, never a replace() pattern: `$'`, `$&`,
  // and `` $` `` all appear inside Zig character-class lists.
  writeFileSync(target, source.replace(original, () => patch.replacement));
}
