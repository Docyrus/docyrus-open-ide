const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;

pub const canvas_label = "docyrus-canvas";
pub const primary_editor_view_label = "docyrus-monaco-primary";
pub const secondary_editor_view_label = "docyrus-monaco-secondary";
pub const tree_view_label = "docyrus-file-tree";
pub const primary_editor_pane_anchor = "primary-editor-pane";
pub const secondary_editor_pane_anchor = "secondary-editor-pane";
pub const tree_pane_anchor = "file-tree-pane";

const bundle_id = "com.docyrus.open-ide";
const max_projects: usize = 10;
const max_recent_projects: usize = 10;
const max_tabs: usize = 10;
const max_file_tabs: usize = 8;
const project_path_capacity: usize = 1024;
const relative_path_capacity: usize = 768;
const title_capacity: usize = 160;
const markdown_capacity: usize = 32 * 1024;
const bridge_file_limit: usize = 768 * 1024;
const bridge_tree_limit: usize = 1200;
const bridge_tree_page_limit: usize = 160;
// Bridge handler results are capped at 12 KiB. Leave room for the response
// envelope and JSON metadata so a large project cannot fail as one payload.
const bridge_tree_page_budget: usize = 9 * 1024;
const clipboard_effect_key_start: u64 = 100;

pub const window_width: f32 = 1440;
pub const window_height: f32 = 920;

const Pane = enum(u8) { primary = 1, secondary = 2 };
const SplitMode = enum { horizontal, vertical };
const ThemeMode = enum(u8) { system = 0, light = 1, dark = 2 };
const FileKind = enum(u8) { code, markdown, image, text };

pub const TabView = struct {
    id: u32,
    title: []const u8,
    icon: []const u8,
    selected: bool,
};

pub const ProjectView = struct {
    id: u32,
    path: []const u8,
    name: []const u8,
    initials: []const u8,
    selected: bool,
};

pub const RecentProjectView = struct {
    id: u32,
    path: []const u8,
    name: []const u8,
};

pub const TabDragMessage = struct {
    sourceId: u32 = 0,
    phase: u8 = 0,
    x: f32 = 0,
    y: f32 = 0,
    viewWidth: f32 = 0,
    viewHeight: f32 = 0,
};

const OpenFileMessage = struct {
    project_id: u32,
    path: []const u8,
    markdown: []const u8 = "",
};

const MarkdownSavedMessage = struct {
    project_id: u32,
    slot: u32,
    content: []const u8,
};

const FileTab = struct {
    used: bool = false,
    kind: FileKind = .text,
    path_buffer: [relative_path_capacity]u8 = undefined,
    path_len: usize = 0,
    title_buffer: [title_capacity]u8 = undefined,
    title_len: usize = 0,
    markdown_buffer: [markdown_capacity]u8 = undefined,
    markdown_len: usize = 0,

    fn path(self: *const FileTab) []const u8 {
        return self.path_buffer[0..self.path_len];
    }

    fn title(self: *const FileTab) []const u8 {
        return self.title_buffer[0..self.title_len];
    }

    fn markdown(self: *const FileTab) []const u8 {
        return self.markdown_buffer[0..self.markdown_len];
    }

    fn setPath(self: *FileTab, value: []const u8) void {
        self.path_len = @min(value.len, self.path_buffer.len);
        @memcpy(self.path_buffer[0..self.path_len], value[0..self.path_len]);
        const basename = std.fs.path.basename(value);
        self.title_len = @min(basename.len, self.title_buffer.len);
        @memcpy(self.title_buffer[0..self.title_len], basename[0..self.title_len]);
        self.kind = fileKind(value);
        self.used = true;
    }

    fn setMarkdown(self: *FileTab, value: []const u8) void {
        self.markdown_len = @min(value.len, self.markdown_buffer.len);
        @memcpy(self.markdown_buffer[0..self.markdown_len], value[0..self.markdown_len]);
    }
};

const LayoutState = struct {
    explorer_open: bool = true,
    explorer_fraction: f32 = 0.215,
    split_fraction: f32 = 0.58,
    markdown_fraction: f32 = 0.56,
    split_mode: SplitMode = .vertical,
    secondary_panel_open: bool = false,
    active_pane: Pane = .primary,
    primary_order: [max_tabs]u8 = [_]u8{0} ** max_tabs,
    primary_tab_count: u8 = 0,
    primary_active_tab: u8 = 0,
    secondary_order: [max_tabs]u8 = [_]u8{0} ** max_tabs,
    secondary_tab_count: u8 = 0,
    secondary_active_tab: u8 = 0,
    file_tabs: [max_file_tabs]FileTab = [_]FileTab{.{}} ** max_file_tabs,
    term_one_scrollback: u32 = 0,
    term_two_scrollback: u32 = 0,
    term_one_started: bool = false,
    term_two_started: bool = false,
    term_one_live: bool = false,
    term_two_live: bool = false,
};

const ProjectState = struct {
    path_buffer: [project_path_capacity]u8 = undefined,
    path_len: usize = 0,
    layout: LayoutState = .{},

    fn path(self: *const ProjectState) []const u8 {
        return self.path_buffer[0..self.path_len];
    }

    fn setPath(self: *ProjectState, value: []const u8) void {
        self.path_len = @min(value.len, self.path_buffer.len);
        @memcpy(self.path_buffer[0..self.path_len], value[0..self.path_len]);
    }
};

const RecentProject = struct {
    path_buffer: [project_path_capacity]u8 = undefined,
    path_len: usize = 0,

    fn path(self: *const RecentProject) []const u8 {
        return self.path_buffer[0..self.path_len];
    }

    fn setPath(self: *RecentProject, value: []const u8) void {
        self.path_len = @min(value.len, self.path_buffer.len);
        @memcpy(self.path_buffer[0..self.path_len], value[0..self.path_len]);
    }
};

pub const Model = struct {
    pub const view_unbound = .{
        "projects",
        "project_count",
        "active_project_id",
        "recent_projects",
        "recent_count",
        "theme_mode",
        "project_switching",
        "directory_picker_requested",
        "drag_active",
        "primary_reload_token",
        "secondary_reload_token",
        "tree_reload_token",
        "primary_url_buffer",
        "primary_url_len",
        "secondary_url_buffer",
        "secondary_url_len",
        "tree_url_buffer",
        "tree_url_len",
        "path_scratch",
        "path_scratch_len",
        "preview_image_request",
        "preview_image_path",
        "preview_image_path_len",
        "clipboard_key",
        "primaryEditorUrl",
        "secondaryEditorUrl",
        "treeUrl",
    };

    projects: [max_projects]ProjectState = [_]ProjectState{.{}} ** max_projects,
    project_count: u8 = 0,
    active_project_id: u32 = 0,
    recent_projects: [max_recent_projects]RecentProject = [_]RecentProject{.{}} ** max_recent_projects,
    recent_count: u8 = 0,
    theme_mode: ThemeMode = .system,
    add_project_open: bool = false,
    settings_open: bool = false,
    project_switching: bool = false,
    directory_picker_requested: bool = false,
    drag_active: bool = false,
    primary_reload_token: u64 = 0,
    secondary_reload_token: u64 = 0,
    tree_reload_token: u64 = 0,
    primary_url_buffer: [256]u8 = undefined,
    primary_url_len: usize = 0,
    secondary_url_buffer: [256]u8 = undefined,
    secondary_url_len: usize = 0,
    tree_url_buffer: [256]u8 = undefined,
    tree_url_len: usize = 0,
    path_scratch: [2048]u8 = undefined,
    path_scratch_len: usize = 0,
    preview_image: u64 = 0,
    preview_image_request: u64 = 1000,
    preview_image_path: [2048]u8 = undefined,
    preview_image_path_len: usize = 0,
    clipboard_key: u64 = clipboard_effect_key_start,

    fn activeProject(model: *Model) ?*ProjectState {
        if (model.active_project_id == 0 or model.active_project_id > model.project_count) return null;
        return &model.projects[@as(usize, @intCast(model.active_project_id - 1))];
    }

    fn activeProjectConst(model: *const Model) ?*const ProjectState {
        if (model.active_project_id == 0 or model.active_project_id > model.project_count) return null;
        return &model.projects[@as(usize, @intCast(model.active_project_id - 1))];
    }

    fn activeLayout(model: *Model) ?*LayoutState {
        const project = model.activeProject() orelse return null;
        return &project.layout;
    }

    fn activeLayoutConst(model: *const Model) ?*const LayoutState {
        const project = model.activeProjectConst() orelse return null;
        return &project.layout;
    }

    pub fn openProjects(model: *const Model, arena: std.mem.Allocator) []const ProjectView {
        const count: usize = model.project_count;
        const views = arena.alloc(ProjectView, count) catch return &.{};
        for (model.projects[0..count], 0..) |*project, index| {
            views[index] = .{
                .id = @intCast(index + 1),
                .path = project.path(),
                .name = projectName(project.path()),
                .initials = projectInitials(project.path(), arena),
                .selected = model.active_project_id == @as(u32, @intCast(index + 1)),
            };
        }
        return views;
    }

    pub fn recentProjects(model: *const Model, arena: std.mem.Allocator) []const RecentProjectView {
        const views = arena.alloc(RecentProjectView, model.recent_count) catch return &.{};
        var count: usize = 0;
        for (model.recent_projects[0..model.recent_count], 0..) |*recent, index| {
            if (model.findProject(recent.path()) != null) continue;
            views[count] = .{
                .id = @intCast(index + 1),
                .path = recent.path(),
                .name = projectName(recent.path()),
            };
            count += 1;
        }
        return views[0..count];
    }

    pub fn has_recent_projects(model: *const Model) bool {
        for (model.recent_projects[0..model.recent_count]) |*recent| {
            if (model.findProject(recent.path()) == null) return true;
        }
        return false;
    }

    pub fn workspace_path(model: *const Model) []const u8 {
        const project = model.activeProjectConst() orelse return "No project";
        return project.path();
    }

    pub fn project_name(model: *const Model) []const u8 {
        return projectName(model.workspace_path());
    }

    pub fn explorer_open(model: *const Model) bool {
        const layout = model.activeLayoutConst() orelse return false;
        return layout.explorer_open;
    }

    pub fn explorer_fraction(model: *const Model) f32 {
        const layout = model.activeLayoutConst() orelse return 0.215;
        return layout.explorer_fraction;
    }

    pub fn split_fraction(model: *const Model) f32 {
        const layout = model.activeLayoutConst() orelse return 0.58;
        return layout.split_fraction;
    }

    pub fn markdown_fraction(model: *const Model) f32 {
        const layout = model.activeLayoutConst() orelse return 0.56;
        return layout.markdown_fraction;
    }

    pub fn split_mode(model: *const Model) SplitMode {
        const layout = model.activeLayoutConst() orelse return .vertical;
        return layout.split_mode;
    }

    pub fn secondary_panel_open(model: *const Model) bool {
        const layout = model.activeLayoutConst() orelse return false;
        return layout.secondary_panel_open;
    }

    pub fn primaryTabs(model: *const Model, arena: std.mem.Allocator) []const TabView {
        return tabViews(model, .primary, arena);
    }

    pub fn secondaryTabs(model: *const Model, arena: std.mem.Allocator) []const TabView {
        return tabViews(model, .secondary, arena);
    }

    pub fn primary_has_tabs(model: *const Model) bool {
        const layout = model.activeLayoutConst() orelse return false;
        return layout.primary_tab_count > 0;
    }

    pub fn secondary_has_tabs(model: *const Model) bool {
        const layout = model.activeLayoutConst() orelse return false;
        return layout.secondary_tab_count > 0;
    }

    pub fn primary_uses_editor(model: *const Model) bool {
        return paneUsesEditor(model, .primary);
    }

    pub fn secondary_uses_editor(model: *const Model) bool {
        return paneUsesEditor(model, .secondary);
    }

    pub fn primary_is_markdown_active(model: *const Model) bool {
        return paneFileKind(model, .primary) == .markdown;
    }

    pub fn secondary_is_markdown_active(model: *const Model) bool {
        return paneFileKind(model, .secondary) == .markdown;
    }

    pub fn primary_is_image_active(model: *const Model) bool {
        return paneFileKind(model, .primary) == .image;
    }

    pub fn secondary_is_image_active(model: *const Model) bool {
        return paneFileKind(model, .secondary) == .image;
    }

    pub fn primary_uses_terminal_one(model: *const Model) bool {
        return paneActive(model, .primary) == 9;
    }

    pub fn secondary_uses_terminal_one(model: *const Model) bool {
        return paneActive(model, .secondary) == 9;
    }

    pub fn primary_uses_terminal_two(model: *const Model) bool {
        return paneActive(model, .primary) == 10;
    }

    pub fn secondary_uses_terminal_two(model: *const Model) bool {
        return paneActive(model, .secondary) == 10;
    }

    pub fn primary_markdown_body(model: *const Model) []const u8 {
        return paneMarkdown(model, .primary);
    }

    pub fn secondary_markdown_body(model: *const Model) []const u8 {
        return paneMarkdown(model, .secondary);
    }

    pub fn primaryEditorUrl(model: *const Model) []const u8 {
        return model.primary_url_buffer[0..model.primary_url_len];
    }

    pub fn secondaryEditorUrl(model: *const Model) []const u8 {
        return model.secondary_url_buffer[0..model.secondary_url_len];
    }

    pub fn treeUrl(model: *const Model) []const u8 {
        return model.tree_url_buffer[0..model.tree_url_len];
    }

    pub fn primary_status_text(model: *const Model, arena: std.mem.Allocator) []const u8 {
        return statusText(model, .primary, arena);
    }

    pub fn secondary_status_text(model: *const Model, arena: std.mem.Allocator) []const u8 {
        return statusText(model, .secondary, arena);
    }

    pub fn shell_key(model: *const Model) u64 {
        return terminalKey(model.active_project_id, 0);
    }

    pub fn secondary_shell_key(model: *const Model) u64 {
        return terminalKey(model.active_project_id, 1);
    }

    pub fn term_one_scrollback(model: *const Model) u32 {
        const layout = model.activeLayoutConst() orelse return 0;
        return layout.term_one_scrollback;
    }

    pub fn term_two_scrollback(model: *const Model) u32 {
        const layout = model.activeLayoutConst() orelse return 0;
        return layout.term_two_scrollback;
    }

    pub fn has_preview_image(model: *const Model) bool {
        return model.preview_image != 0;
    }

    pub fn preview_image_title(model: *const Model) []const u8 {
        const layout = model.activeLayoutConst() orelse return "Image";
        const id = paneActive(model, layout.active_pane);
        if (id < 1 or id > max_file_tabs) return "Image";
        return layout.file_tabs[id - 1].title();
    }

    pub fn theme_system_selected(model: *const Model) bool {
        return model.theme_mode == .system;
    }

    pub fn theme_light_selected(model: *const Model) bool {
        return model.theme_mode == .light;
    }

    pub fn theme_dark_selected(model: *const Model) bool {
        return model.theme_mode == .dark;
    }

    fn findProject(model: *const Model, path: []const u8) ?usize {
        for (model.projects[0..model.project_count], 0..) |*project, index| {
            if (std.mem.eql(u8, project.path(), path)) return index;
        }
        return null;
    }
};

pub const Msg = union(enum) {
    pub const view_unbound = .{
        "pty",
        "clipboard_result",
        "image_loaded",
        "directory_selected",
        "directory_picker_cancelled",
        "open_file",
        "markdown_saved",
        "finish_project_switch",
    };

    pty: native_sdk.EffectPtyEvent,
    clipboard_result: native_sdk.EffectClipboardResult,
    image_loaded: native_sdk.EffectImageResult,
    term_one_state: canvas.TerminalState,
    term_two_state: canvas.TerminalState,
    explorer_resized: f32,
    split_resized: f32,
    markdown_resized: f32,
    toggle_explorer,
    activate_tab: u32,
    drag_tab: TabDragMessage,
    close_tab: u32,
    close_other_tabs: u32,
    close_all_tabs: u32,
    copy_path: u32,
    copy_relative_path: u32,
    reveal_in_finder: u32,
    open_terminal_in: u32,
    split_horizontal,
    split_vertical,
    select_project: u32,
    open_add_project,
    close_add_project,
    choose_project_directory,
    open_recent_project: u32,
    directory_selected: []const u8,
    directory_picker_cancelled,
    open_settings,
    close_settings,
    set_theme_system,
    set_theme_light,
    set_theme_dark,
    open_file: OpenFileMessage,
    markdown_saved: MarkdownSavedMessage,
    refresh_files,
    finish_project_switch,
};

const DocyrusApp = native_sdk.UiAppWithFeatures(Model, Msg, .{ .runtime_markup = builtin.mode == .Debug });
pub const Effects = DocyrusApp.Effects;

pub fn boot(_: *Model, _: *Effects) void {}

fn projectName(path: []const u8) []const u8 {
    if (path.len == 0) return "Project";
    return std.fs.path.basename(path);
}

fn projectInitials(path: []const u8, arena: std.mem.Allocator) []const u8 {
    const name = projectName(path);
    const output = arena.alloc(u8, @min(@as(usize, 2), name.len)) catch return "PR";
    for (output, 0..) |*byte, index| byte.* = std.ascii.toUpper(name[index]);
    return output;
}

fn fileKind(path: []const u8) FileKind {
    const extension = std.fs.path.extension(path);
    if (std.ascii.eqlIgnoreCase(extension, ".md") or std.ascii.eqlIgnoreCase(extension, ".markdown")) return .markdown;
    const image_extensions = [_][]const u8{ ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp" };
    for (image_extensions) |candidate| if (std.ascii.eqlIgnoreCase(extension, candidate)) return .image;
    const text_extensions = [_][]const u8{ ".txt", ".log", ".csv", ".tsv" };
    for (text_extensions) |candidate| if (std.ascii.eqlIgnoreCase(extension, candidate)) return .text;
    return .code;
}

fn themeName(mode: ThemeMode) []const u8 {
    return switch (mode) {
        .system => "system",
        .light => "light",
        .dark => "dark",
    };
}

fn terminalKey(project_id: u32, terminal_index: u8) u64 {
    if (project_id == 0) return 0;
    return (@as(u64, project_id - 1) * 2) + terminal_index + 1;
}

fn tabTitle(layout: *const LayoutState, id: u32) []const u8 {
    return switch (id) {
        1...8 => layout.file_tabs[id - 1].title(),
        9 => "Terminal",
        10 => "Terminal 2",
        else => "",
    };
}

fn tabIcon(layout: *const LayoutState, id: u32) []const u8 {
    return switch (id) {
        1...8 => switch (layout.file_tabs[id - 1].kind) {
            .image => "image",
            .markdown => "file-text",
            .code => "code",
            .text => "file",
        },
        9, 10 => "terminal",
        else => "file",
    };
}

fn paneOrder(layout: *const LayoutState, pane: Pane) []const u8 {
    return if (pane == .primary)
        layout.primary_order[0..layout.primary_tab_count]
    else
        layout.secondary_order[0..layout.secondary_tab_count];
}

fn paneActive(model: *const Model, pane: Pane) u8 {
    const layout = model.activeLayoutConst() orelse return 0;
    return if (pane == .primary) layout.primary_active_tab else layout.secondary_active_tab;
}

fn setPaneActive(layout: *LayoutState, pane: Pane, id: u8) void {
    if (pane == .primary) layout.primary_active_tab = id else layout.secondary_active_tab = id;
}

fn paneCount(layout: *const LayoutState, pane: Pane) u8 {
    return if (pane == .primary) layout.primary_tab_count else layout.secondary_tab_count;
}

fn paneFileKind(model: *const Model, pane: Pane) ?FileKind {
    const layout = model.activeLayoutConst() orelse return null;
    const id = paneActive(model, pane);
    if (id < 1 or id > max_file_tabs) return null;
    return layout.file_tabs[id - 1].kind;
}

fn paneUsesEditor(model: *const Model, pane: Pane) bool {
    const kind = paneFileKind(model, pane) orelse return false;
    return kind != .image;
}

fn paneMarkdown(model: *const Model, pane: Pane) []const u8 {
    const layout = model.activeLayoutConst() orelse return "";
    const id = paneActive(model, pane);
    if (id < 1 or id > max_file_tabs) return "";
    return layout.file_tabs[id - 1].markdown();
}

fn tabViews(model: *const Model, pane: Pane, arena: std.mem.Allocator) []const TabView {
    const layout = model.activeLayoutConst() orelse return &.{};
    const order = paneOrder(layout, pane);
    const views = arena.alloc(TabView, order.len) catch return &.{};
    const active = paneActive(model, pane);
    for (order, 0..) |id, index| {
        views[index] = .{ .id = id, .title = tabTitle(layout, id), .icon = tabIcon(layout, id), .selected = active == id };
    }
    return views;
}

fn paneForTab(layout: *const LayoutState, id: u32) ?Pane {
    for (paneOrder(layout, .primary)) |candidate| if (candidate == id) return .primary;
    for (paneOrder(layout, .secondary)) |candidate| if (candidate == id) return .secondary;
    return null;
}

fn tabIndex(layout: *const LayoutState, pane: Pane, id: u32) ?usize {
    for (paneOrder(layout, pane), 0..) |candidate, index| if (candidate == id) return index;
    return null;
}

fn statusText(model: *const Model, pane: Pane, arena: std.mem.Allocator) []const u8 {
    const layout = model.activeLayoutConst() orelse return "Ready";
    const id = paneActive(model, pane);
    if (id == 0) return "Ready";
    if (id == 9 or id == 10) {
        const live = if (id == 9) layout.term_one_live else layout.term_two_live;
        return std.fmt.allocPrint(arena, "{s}  |  {s}", .{ model.workspace_path(), if (live) "terminal connected" else "terminal starting" }) catch "Terminal";
    }
    return std.fmt.allocPrint(arena, "{s}  |  UTF-8", .{tabTitle(layout, id)}) catch "Docyrus Open IDE";
}

fn normalizeProjectPath(path: []const u8) []const u8 {
    var end = path.len;
    while (end > 1 and (path[end - 1] == '/' or path[end - 1] == '\\')) end -= 1;
    return path[0..end];
}

fn addRecentProject(model: *Model, raw_path: []const u8) void {
    const path = normalizeProjectPath(raw_path);
    if (path.len == 0) return;
    var existing: ?usize = null;
    for (model.recent_projects[0..model.recent_count], 0..) |*recent, index| {
        if (std.mem.eql(u8, recent.path(), path)) {
            existing = index;
            break;
        }
    }
    const source_index = existing orelse @min(@as(usize, model.recent_count), max_recent_projects - 1);
    if (existing == null and model.recent_count < max_recent_projects) model.recent_count += 1;
    var cursor = source_index;
    while (cursor > 0) : (cursor -= 1) model.recent_projects[cursor] = model.recent_projects[cursor - 1];
    model.recent_projects[0].setPath(path);
}

fn addProject(model: *Model, raw_path: []const u8) ?u32 {
    const path = normalizeProjectPath(raw_path);
    // Project roots must always be absolute. This prevents file operations from
    // ever resolving relative to the directory that launched the app.
    if (path.len == 0 or !std.fs.path.isAbsolute(path)) return null;
    if (model.findProject(path)) |index| {
        addRecentProject(model, path);
        return @intCast(index + 1);
    }
    if (model.project_count >= max_projects) return null;
    const index: usize = model.project_count;
    model.projects[index] = .{};
    model.projects[index].setPath(path);
    model.project_count += 1;
    addRecentProject(model, path);
    return @intCast(index + 1);
}

fn selectProject(model: *Model, project_id: u32) void {
    if (project_id == 0 or project_id > model.project_count or project_id == model.active_project_id) return;
    model.active_project_id = project_id;
    model.project_switching = true;
    model.preview_image = 0;
    model.primary_reload_token +%= 1;
    model.secondary_reload_token +%= 1;
    model.tree_reload_token +%= 1;
    syncUrls(model);
}

fn syncUrls(model: *Model) void {
    const theme = themeName(model.theme_mode);
    const primary_slot = paneActive(model, .primary);
    const secondary_slot = paneActive(model, .secondary);
    const primary = std.fmt.bufPrint(&model.primary_url_buffer, "zero://app/index.html?project={d}&slot={d}&theme={s}", .{ model.active_project_id, primary_slot, theme }) catch "";
    model.primary_url_len = primary.len;
    const secondary = std.fmt.bufPrint(&model.secondary_url_buffer, "zero://app/index.html?project={d}&slot={d}&theme={s}", .{ model.active_project_id, secondary_slot, theme }) catch "";
    model.secondary_url_len = secondary.len;
    const tree = std.fmt.bufPrint(&model.tree_url_buffer, "zero://app/tree.html?project={d}&theme={s}", .{ model.active_project_id, theme }) catch "";
    model.tree_url_len = tree.len;
}

fn insertTabRaw(layout: *LayoutState, pane: Pane, id: u8, requested_index: usize) void {
    const count: usize = paneCount(layout, pane);
    if (count >= max_tabs) return;
    const index = @min(requested_index, count);
    if (pane == .primary) {
        var cursor = count;
        while (cursor > index) : (cursor -= 1) layout.primary_order[cursor] = layout.primary_order[cursor - 1];
        layout.primary_order[index] = id;
        layout.primary_tab_count += 1;
    } else {
        var cursor = count;
        while (cursor > index) : (cursor -= 1) layout.secondary_order[cursor] = layout.secondary_order[cursor - 1];
        layout.secondary_order[index] = id;
        layout.secondary_tab_count += 1;
        layout.secondary_panel_open = true;
    }
}

fn removeTabRaw(layout: *LayoutState, pane: Pane, index: usize) u8 {
    if (pane == .primary) {
        const removed = layout.primary_order[index];
        var cursor = index;
        while (cursor + 1 < layout.primary_tab_count) : (cursor += 1) layout.primary_order[cursor] = layout.primary_order[cursor + 1];
        layout.primary_tab_count -= 1;
        layout.primary_order[layout.primary_tab_count] = 0;
        return removed;
    }
    const removed = layout.secondary_order[index];
    var cursor = index;
    while (cursor + 1 < layout.secondary_tab_count) : (cursor += 1) layout.secondary_order[cursor] = layout.secondary_order[cursor + 1];
    layout.secondary_tab_count -= 1;
    layout.secondary_order[layout.secondary_tab_count] = 0;
    return removed;
}

fn syncPaneActive(layout: *LayoutState, pane: Pane) void {
    const active = if (pane == .primary) layout.primary_active_tab else layout.secondary_active_tab;
    if (active != 0 and tabIndex(layout, pane, active) != null) return;
    const order = paneOrder(layout, pane);
    setPaneActive(layout, pane, if (order.len > 0) order[0] else 0);
}

fn activeFileSlot(layout: *const LayoutState, pane: Pane) ?usize {
    const id = if (pane == .primary) layout.primary_active_tab else layout.secondary_active_tab;
    if (id < 1 or id > max_file_tabs) return null;
    if (!layout.file_tabs[id - 1].used) return null;
    return id - 1;
}

fn findFileSlot(layout: *const LayoutState, path: []const u8) ?usize {
    for (&layout.file_tabs, 0..) |*tab, index| {
        if (tab.used and std.mem.eql(u8, tab.path(), path)) return index;
    }
    return null;
}

fn availableFileSlot(layout: *const LayoutState) ?usize {
    for (&layout.file_tabs, 0..) |*tab, index| if (!tab.used) return index;
    return null;
}

fn activateTab(model: *Model, id: u32, fx: *Effects) void {
    const layout = model.activeLayout() orelse return;
    if (id < 1 or id > max_tabs) return;
    if (id <= max_file_tabs and !layout.file_tabs[id - 1].used) return;
    const pane = paneForTab(layout, id) orelse layout.active_pane;
    if (paneForTab(layout, id) == null) insertTabRaw(layout, pane, @intCast(id), paneCount(layout, pane));
    setPaneActive(layout, pane, @intCast(id));
    layout.active_pane = pane;
    if (id == 9 or id == 10) ensureTerminal(model, @intCast(id - 9), fx);
    if (id <= max_file_tabs and layout.file_tabs[id - 1].kind == .image) ensureImage(model, id, fx);
    if (pane == .primary) model.primary_reload_token +%= 1 else model.secondary_reload_token +%= 1;
    syncUrls(model);
}

fn openFile(model: *Model, message: OpenFileMessage, fx: *Effects) void {
    if (message.project_id != model.active_project_id or !isSafeRelativePath(message.path)) return;
    const layout = model.activeLayout() orelse return;
    const slot = findFileSlot(layout, message.path) orelse availableFileSlot(layout) orelse return;
    if (!layout.file_tabs[slot].used) layout.file_tabs[slot].setPath(message.path);
    if (layout.file_tabs[slot].kind == .markdown) layout.file_tabs[slot].setMarkdown(message.markdown);
    activateTab(model, @intCast(slot + 1), fx);
}

fn closeTab(model: *Model, id: u32) void {
    const layout = model.activeLayout() orelse return;
    const pane = paneForTab(layout, id) orelse return;
    const index = tabIndex(layout, pane, id) orelse return;
    _ = removeTabRaw(layout, pane, index);
    syncPaneActive(layout, pane);
    if (pane == .secondary and layout.secondary_tab_count == 0) layout.secondary_panel_open = false;
    if (id <= max_file_tabs) layout.file_tabs[id - 1] = .{};
    model.primary_reload_token +%= 1;
    model.secondary_reload_token +%= 1;
    syncUrls(model);
}

fn closeOtherTabs(model: *Model, id: u32, fx: *Effects) void {
    const layout = model.activeLayout() orelse return;
    const pane = paneForTab(layout, id) orelse return;
    const old_order = paneOrder(layout, pane);
    for (old_order) |candidate| {
        if (candidate <= max_file_tabs and candidate != id) layout.file_tabs[candidate - 1] = .{};
    }
    if (pane == .primary) {
        layout.primary_order = [_]u8{0} ** max_tabs;
        layout.primary_order[0] = @intCast(id);
        layout.primary_tab_count = 1;
    } else {
        layout.secondary_order = [_]u8{0} ** max_tabs;
        layout.secondary_order[0] = @intCast(id);
        layout.secondary_tab_count = 1;
        layout.secondary_panel_open = true;
    }
    setPaneActive(layout, pane, @intCast(id));
    layout.active_pane = pane;
    if (id == 9 or id == 10) ensureTerminal(model, @intCast(id - 9), fx);
    model.primary_reload_token +%= 1;
    model.secondary_reload_token +%= 1;
    syncUrls(model);
}

fn closeAllTabs(model: *Model, source_id: u32) void {
    const layout = model.activeLayout() orelse return;
    const pane = paneForTab(layout, source_id) orelse return;
    for (paneOrder(layout, pane)) |candidate| {
        if (candidate <= max_file_tabs) layout.file_tabs[candidate - 1] = .{};
    }
    if (pane == .primary) {
        layout.primary_order = [_]u8{0} ** max_tabs;
        layout.primary_tab_count = 0;
        layout.primary_active_tab = 0;
    } else {
        layout.secondary_order = [_]u8{0} ** max_tabs;
        layout.secondary_tab_count = 0;
        layout.secondary_active_tab = 0;
        layout.secondary_panel_open = false;
    }
    model.primary_reload_token +%= 1;
    model.secondary_reload_token +%= 1;
    syncUrls(model);
}

fn openTerminalIn(model: *Model, pane_id: u32, fx: *Effects) void {
    const layout = model.activeLayout() orelse return;
    const pane: Pane = if (pane_id == 2) .secondary else .primary;
    for (paneOrder(layout, pane)) |id| {
        if (id == 9 or id == 10) {
            layout.active_pane = pane;
            activateTab(model, id, fx);
            return;
        }
    }
    const id: u32 = if (paneForTab(layout, 9) == null) 9 else 10;
    layout.active_pane = pane;
    activateTab(model, id, fx);
}

fn dragDestination(layout: *LayoutState, event: TabDragMessage) Pane {
    const content_width = @max(@as(f32, 1), event.viewWidth - 64);
    const explorer_width = if (layout.explorer_open) content_width * layout.explorer_fraction else 0;
    const workspace_x = 64 + explorer_width;
    const workspace_width = @max(@as(f32, 1), event.viewWidth - workspace_x);
    if (!layout.secondary_panel_open) {
        if (event.x > workspace_x + workspace_width * 0.72) {
            layout.secondary_panel_open = true;
            layout.split_mode = .vertical;
            return .secondary;
        }
        if (event.y > event.viewHeight * 0.70) {
            layout.secondary_panel_open = true;
            layout.split_mode = .horizontal;
            return .secondary;
        }
        return .primary;
    }
    return switch (layout.split_mode) {
        .vertical => if (event.x < workspace_x + workspace_width * layout.split_fraction) .primary else .secondary,
        .horizontal => if (event.y < 42 + (event.viewHeight - 42) * layout.split_fraction) .primary else .secondary,
    };
}

fn dragInsertionIndex(layout: *const LayoutState, pane: Pane, event: TabDragMessage) usize {
    const content_width = @max(@as(f32, 1), event.viewWidth - 64);
    const explorer_width = if (layout.explorer_open) content_width * layout.explorer_fraction else 0;
    const workspace_x = 64 + explorer_width;
    const workspace_width = @max(@as(f32, 1), event.viewWidth - workspace_x);
    var origin = workspace_x;
    var width = workspace_width;
    if (layout.secondary_panel_open and layout.split_mode == .vertical) {
        const primary_width = workspace_width * layout.split_fraction;
        if (pane == .primary) width = primary_width else {
            origin += primary_width;
            width -= primary_width;
        }
    }
    const fraction = std.math.clamp((event.x - origin) / @max(@as(f32, 1), width), 0, 0.98);
    return @intFromFloat(@floor(fraction * @as(f32, @floatFromInt(paneCount(layout, pane) + 1))));
}

fn completeTabDrop(model: *Model, event: TabDragMessage, fx: *Effects) void {
    const layout = model.activeLayout() orelse return;
    const id = event.sourceId;
    const source = paneForTab(layout, id) orelse return;
    const source_index = tabIndex(layout, source, id) orelse return;
    const destination = dragDestination(layout, event);
    _ = removeTabRaw(layout, source, source_index);
    syncPaneActive(layout, source);
    insertTabRaw(layout, destination, @intCast(id), dragInsertionIndex(layout, destination, event));
    setPaneActive(layout, destination, @intCast(id));
    layout.active_pane = destination;
    if (source == .secondary and destination != .secondary and layout.secondary_tab_count == 0) layout.secondary_panel_open = false;
    if (id == 9 or id == 10) ensureTerminal(model, @intCast(id - 9), fx);
    model.primary_reload_token +%= 1;
    model.secondary_reload_token +%= 1;
    syncUrls(model);
}

fn handleTabDrag(model: *Model, event: TabDragMessage, fx: *Effects) void {
    switch (event.phase) {
        0 => model.drag_active = true,
        1 => {
            if (model.drag_active) completeTabDrop(model, event, fx);
            model.drag_active = false;
        },
        2 => model.drag_active = false,
        else => {},
    }
}

fn setSplit(model: *Model, mode: SplitMode) void {
    const layout = model.activeLayout() orelse return;
    layout.split_mode = mode;
    layout.secondary_panel_open = true;
}

fn isSafeRelativePath(path: []const u8) bool {
    if (path.len == 0 or std.fs.path.isAbsolute(path) or std.mem.indexOfScalar(u8, path, 0) != null) return false;
    var parts = std.mem.tokenizeAny(u8, path, "/\\");
    while (parts.next()) |part| if (std.mem.eql(u8, part, "..")) return false;
    return true;
}

fn fullPath(project: *const ProjectState, relative: []const u8, output: []u8) ![]const u8 {
    if (!isSafeRelativePath(relative)) return error.InvalidPath;
    return std.fmt.bufPrint(output, "{s}/{s}", .{ project.path(), relative });
}

fn fullPathForTab(model: *Model, id: u32) []const u8 {
    const project = model.activeProject() orelse return "";
    if (id == 9 or id == 10) return project.path();
    const layout = &project.layout;
    if (id < 1 or id > max_file_tabs or !layout.file_tabs[id - 1].used) return project.path();
    const value = fullPath(project, layout.file_tabs[id - 1].path(), &model.path_scratch) catch return project.path();
    model.path_scratch_len = value.len;
    return model.path_scratch[0..model.path_scratch_len];
}

fn relativePathForTab(model: *const Model, id: u32) []const u8 {
    const layout = model.activeLayoutConst() orelse return "";
    if (id == 9 or id == 10) return ".";
    if (id < 1 or id > max_file_tabs or !layout.file_tabs[id - 1].used) return "";
    return layout.file_tabs[id - 1].path();
}

fn copyTabPath(model: *Model, id: u32, absolute: bool, fx: *Effects) void {
    const path = if (absolute) fullPathForTab(model, id) else relativePathForTab(model, id);
    if (path.len == 0) return;
    const key = model.clipboard_key;
    model.clipboard_key +%= 1;
    fx.writeClipboard(.{ .key = key, .text = path, .on_result = Effects.clipboardMsg(.clipboard_result) });
}

fn ensureImage(model: *Model, id: u32, fx: *Effects) void {
    const path = fullPathForTab(model, id);
    model.preview_image_path_len = @min(path.len, model.preview_image_path.len);
    @memcpy(model.preview_image_path[0..model.preview_image_path_len], path[0..model.preview_image_path_len]);
    model.preview_image = 0;
    model.preview_image_request +%= 1;
    fx.loadImage(.{ .id = model.preview_image_request, .path = model.preview_image_path[0..model.preview_image_path_len], .on_result = Effects.imageMsg(.image_loaded) });
}

fn shellArgv(project: *const ProjectState, storage: *[5][]const u8) []const []const u8 {
    if (builtin.os.tag == .macos) {
        storage.* = .{ "/bin/zsh", "-lc", "cd -- \"$1\" && exec /bin/zsh -i", "docyrus", project.path() };
        return storage;
    }
    if (builtin.os.tag == .windows) return &.{"cmd.exe"};
    storage.* = .{ "/bin/sh", "-lc", "cd -- \"$1\" && exec /bin/sh -i", "docyrus", project.path() };
    return storage;
}

fn ensureTerminal(model: *Model, terminal_index: u8, fx: *Effects) void {
    const project = model.activeProject() orelse return;
    const started = if (terminal_index == 0) project.layout.term_one_started else project.layout.term_two_started;
    if (started) return;
    if (terminal_index == 0) project.layout.term_one_started = true else project.layout.term_two_started = true;
    var storage: [5][]const u8 = undefined;
    fx.ptySpawn(.{
        .key = terminalKey(model.active_project_id, terminal_index),
        .argv = shellArgv(project, &storage),
        .cols = 100,
        .rows = 28,
        .on_event = Effects.ptyMsg(.pty),
    });
}

fn handlePtyEvent(model: *Model, event: native_sdk.EffectPtyEvent) void {
    if (event.key == 0) return;
    const project_index: usize = @intCast((event.key - 1) / 2);
    if (project_index >= model.project_count) return;
    const terminal_index: u8 = @intCast((event.key - 1) % 2);
    const layout = &model.projects[project_index].layout;
    switch (event.kind) {
        .output => if (terminal_index == 0) {
            layout.term_one_live = true;
        } else {
            layout.term_two_live = true;
        },
        .exit => if (terminal_index == 0) {
            layout.term_one_live = false;
            layout.term_one_started = false;
        } else {
            layout.term_two_live = false;
            layout.term_two_started = false;
        },
        .write => unreachable,
    }
}

pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    switch (msg) {
        .pty => |event| handlePtyEvent(model, event),
        .clipboard_result => {},
        .image_loaded => |result| if (result.id == model.preview_image_request and result.outcome == .loaded) {
            model.preview_image = result.id;
        },
        .term_one_state => |state| if (model.activeLayout()) |layout| {
            layout.term_one_scrollback = state.scrollback;
        },
        .term_two_state => |state| if (model.activeLayout()) |layout| {
            layout.term_two_scrollback = state.scrollback;
        },
        .explorer_resized => |fraction| if (model.activeLayout()) |layout| {
            layout.explorer_fraction = fraction;
        },
        .split_resized => |fraction| if (model.activeLayout()) |layout| {
            layout.split_fraction = fraction;
        },
        .markdown_resized => |fraction| if (model.activeLayout()) |layout| {
            layout.markdown_fraction = fraction;
        },
        .toggle_explorer => if (model.activeLayout()) |layout| {
            layout.explorer_open = !layout.explorer_open;
        },
        .activate_tab => |id| activateTab(model, id, fx),
        .drag_tab => |event| handleTabDrag(model, event, fx),
        .close_tab => |id| closeTab(model, id),
        .close_other_tabs => |id| closeOtherTabs(model, id, fx),
        .close_all_tabs => |id| closeAllTabs(model, id),
        .copy_path => |id| copyTabPath(model, id, true, fx),
        .copy_relative_path => |id| copyTabPath(model, id, false, fx),
        .reveal_in_finder => |id| fx.hostSend("native-sdk.os.revealPath", fullPathForTab(model, id)),
        .open_terminal_in => |pane_id| openTerminalIn(model, pane_id, fx),
        .split_horizontal => setSplit(model, .horizontal),
        .split_vertical => setSplit(model, .vertical),
        .select_project => |project_id| selectProject(model, project_id),
        .open_add_project => model.add_project_open = true,
        .close_add_project => {
            model.add_project_open = false;
            model.directory_picker_requested = false;
        },
        .choose_project_directory => model.directory_picker_requested = true,
        .open_recent_project => |recent_id| {
            if (recent_id > 0 and recent_id <= model.recent_count) {
                const path = model.recent_projects[recent_id - 1].path();
                var copy: [project_path_capacity]u8 = undefined;
                const length = @min(path.len, copy.len);
                @memcpy(copy[0..length], path[0..length]);
                if (addProject(model, copy[0..length])) |project_id| {
                    model.add_project_open = false;
                    selectProject(model, project_id);
                    if (model.active_project_id == project_id and !model.project_switching) {
                        model.project_switching = true;
                        syncUrls(model);
                    }
                }
            }
        },
        .directory_selected => |path| if (addProject(model, path)) |project_id| {
            model.add_project_open = false;
            model.directory_picker_requested = false;
            if (project_id == model.active_project_id) {
                model.project_switching = true;
                model.tree_reload_token +%= 1;
                syncUrls(model);
            } else selectProject(model, project_id);
        },
        .directory_picker_cancelled => model.directory_picker_requested = false,
        .open_settings => model.settings_open = true,
        .close_settings => model.settings_open = false,
        .set_theme_system, .set_theme_light, .set_theme_dark => {
            model.theme_mode = switch (msg) {
                .set_theme_light => .light,
                .set_theme_dark => .dark,
                else => .system,
            };
            model.primary_reload_token +%= 1;
            model.secondary_reload_token +%= 1;
            model.tree_reload_token +%= 1;
            syncUrls(model);
        },
        .open_file => |message| openFile(model, message, fx),
        .markdown_saved => |message| {
            if (message.project_id == model.active_project_id) {
                const layout = model.activeLayout() orelse return;
                if (message.slot >= 1 and message.slot <= max_file_tabs and layout.file_tabs[message.slot - 1].kind == .markdown) {
                    layout.file_tabs[message.slot - 1].setMarkdown(message.content);
                }
            }
        },
        .refresh_files => model.tree_reload_token +%= 1,
        .finish_project_switch => model.project_switching = false,
    }
}

pub const app_markup = @embedFile("app.native");
pub const CompiledAppView = canvas.CompiledMarkupView(Model, Msg, app_markup);

fn parkedPane(label: []const u8, url: []const u8, reload_token: u64) DocyrusApp.WebViewPane {
    return .{ .label = label, .frame = geometry.RectF.init(0, 0, 1, 1), .url = url, .reload_token = reload_token };
}

fn modalOpen(model: *const Model) bool {
    return model.add_project_open or model.settings_open or model.project_switching;
}

pub fn webPanes(model: *const Model, out: []DocyrusApp.WebViewPane) usize {
    out[0] = if (!modalOpen(model) and paneUsesEditor(model, .primary)) .{
        .label = primary_editor_view_label,
        .anchor = primary_editor_pane_anchor,
        .url = model.primaryEditorUrl(),
        .reload_token = model.primary_reload_token,
    } else parkedPane(primary_editor_view_label, model.primaryEditorUrl(), model.primary_reload_token);

    out[1] = if (!modalOpen(model) and model.secondary_panel_open() and paneUsesEditor(model, .secondary)) .{
        .label = secondary_editor_view_label,
        .anchor = secondary_editor_pane_anchor,
        .url = model.secondaryEditorUrl(),
        .reload_token = model.secondary_reload_token,
    } else parkedPane(secondary_editor_view_label, model.secondaryEditorUrl(), model.secondary_reload_token);

    out[2] = if (!modalOpen(model) and model.explorer_open()) .{
        .label = tree_view_label,
        .anchor = tree_pane_anchor,
        .url = model.treeUrl(),
        .reload_token = model.tree_reload_token,
    } else parkedPane(tree_view_label, model.treeUrl(), model.tree_reload_token);
    return 3;
}

fn themeState(model: *const Model) DocyrusApp.ThemeState {
    return .{ .color_scheme = switch (model.theme_mode) {
        .system => .system,
        .light => .light,
        .dark => .dark,
    } };
}

test "each project owns an independent empty layout" {
    var model: Model = .{};
    const first = addProject(&model, "/tmp/project-one").?;
    model.active_project_id = first;
    syncUrls(&model);
    var fx: Effects = undefined;
    openFile(&model, .{ .project_id = first, .path = "README.md", .markdown = "# One" }, &fx);
    try std.testing.expectEqual(@as(u8, 1), model.projects[0].layout.primary_tab_count);

    const second = addProject(&model, "/tmp/project-two").?;
    selectProject(&model, second);
    update(&model, .finish_project_switch, &fx);
    try std.testing.expectEqual(@as(u8, 0), model.projects[1].layout.primary_tab_count);
    try std.testing.expectEqualStrings("/tmp/project-two", model.workspace_path());

    selectProject(&model, first);
    update(&model, .finish_project_switch, &fx);
    try std.testing.expectEqual(@as(u8, 1), model.projects[0].layout.primary_tab_count);
    try std.testing.expectEqualStrings("# One", model.primary_markdown_body());
}

test "tab dragging mutates only when the drop completes" {
    var model: Model = .{};
    model.active_project_id = addProject(&model, "/tmp/project").?;
    syncUrls(&model);
    var fx: Effects = undefined;
    openFile(&model, .{ .project_id = 1, .path = "one.zig" }, &fx);
    openFile(&model, .{ .project_id = 1, .path = "two.zig" }, &fx);
    const before = model.projects[0].layout.primary_order;
    handleTabDrag(&model, .{ .sourceId = 2, .phase = 0, .x = 1100, .y = 60, .viewWidth = 1200, .viewHeight = 800 }, &fx);
    try std.testing.expectEqualSlices(u8, &before, &model.projects[0].layout.primary_order);
    handleTabDrag(&model, .{ .sourceId = 2, .phase = 1, .x = 1100, .y = 60, .viewWidth = 1200, .viewHeight = 800 }, &fx);
    try std.testing.expectEqual(Pane.secondary, paneForTab(&model.projects[0].layout, 2).?);
}

test "modals and project switches park every child webview" {
    var model: Model = .{};
    model.active_project_id = addProject(&model, "/tmp/project").?;
    syncUrls(&model);
    model.settings_open = true;
    var panes: [3]DocyrusApp.WebViewPane = undefined;
    _ = webPanes(&model, &panes);
    for (panes) |pane| {
        try std.testing.expectEqual(@as(f32, 1), pane.frame.width);
        try std.testing.expect(pane.anchor == null);
    }
}

test "recent projects use a ten item MRU" {
    var model: Model = .{};
    var buffer: [64]u8 = undefined;
    for (0..12) |index| {
        const path = try std.fmt.bufPrint(&buffer, "/tmp/recent-{d}", .{index});
        addRecentProject(&model, path);
    }
    try std.testing.expectEqual(@as(u8, 10), model.recent_count);
    try std.testing.expectEqualStrings("/tmp/recent-11", model.recent_projects[0].path());
    try std.testing.expectEqualStrings("/tmp/recent-2", model.recent_projects[9].path());
}

test "file tree reads only the selected absolute project root" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(std.testing.io, "nested");
    try tmp.dir.createDirPath(std.testing.io, ".git");
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "inside.txt", .data = "inside" });
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "nested/child.md", .data = "# Child" });
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = ".git/ignored.txt", .data = "ignored" });

    var root_storage: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root_len = try tmp.dir.realPath(std.testing.io, &root_storage);
    const root = root_storage[0..root_len];
    var output: [64 * 1024]u8 = undefined;
    const json = try writeProjectTreeJson(std.testing.io, root, 0, &output);

    const Payload = struct {
        root: []const u8,
        paths: []const []const u8,
        nextOffset: usize,
        done: bool,
        truncated: bool,
        skipped: usize,
    };
    const parsed = try std.json.parseFromSlice(Payload, std.testing.allocator, json, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings(root, parsed.value.root);
    try std.testing.expect(parsed.value.done);
    try std.testing.expect(!parsed.value.truncated);

    var saw_root_file = false;
    var saw_nested_file = false;
    for (parsed.value.paths) |path| {
        if (std.mem.eql(u8, path, "inside.txt")) saw_root_file = true;
        if (std.mem.eql(u8, path, "nested/child.md")) saw_nested_file = true;
        try std.testing.expect(!std.mem.startsWith(u8, path, ".git"));
        try std.testing.expect(!std.mem.eql(u8, path, "src/main.zig"));
    }
    try std.testing.expect(saw_root_file);
    try std.testing.expect(saw_nested_file);

    var model: Model = .{};
    try std.testing.expect(addProject(&model, "relative/project") == null);
    try std.testing.expect(addProject(&model, root) != null);
}

test "file tree paginates without losing project entries" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    for (0..bridge_tree_page_limit + 17) |index| {
        var path_buffer: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&path_buffer, "file-{d}.txt", .{index});
        try tmp.dir.writeFile(std.testing.io, .{ .sub_path = path, .data = "test" });
    }

    var root_storage: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root_len = try tmp.dir.realPath(std.testing.io, &root_storage);
    const root = root_storage[0..root_len];
    const Payload = struct {
        paths: []const []const u8,
        nextOffset: usize,
        done: bool,
    };

    var output: [64 * 1024]u8 = undefined;
    var offset: usize = 0;
    var total: usize = 0;
    var pages: usize = 0;
    while (true) {
        const json = try writeProjectTreeJson(std.testing.io, root, offset, &output);
        const parsed = try std.json.parseFromSlice(Payload, std.testing.allocator, json, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        try std.testing.expect(parsed.value.nextOffset > offset);
        total += parsed.value.paths.len;
        pages += 1;
        if (parsed.value.done) break;
        offset = parsed.value.nextOffset;
    }

    try std.testing.expect(pages > 1);
    try std.testing.expectEqual(bridge_tree_page_limit + 17, total);
}

const app_permissions = [_][]const u8{
    native_sdk.security.permission_command,
    native_sdk.security.permission_view,
    native_sdk.security.permission_clipboard,
    native_sdk.security.permission_filesystem,
};

const shell_views = [_]native_sdk.ShellView{
    .{
        .label = canvas_label,
        .kind = .gpu_surface,
        .fill = true,
        .role = "Docyrus workspace",
        .accessibility_label = "Docyrus Open IDE",
        .gpu_backend = .metal,
        .gpu_pixel_format = .bgra8_unorm,
        .gpu_present_mode = .timer,
        .gpu_alpha_mode = .@"opaque",
        .gpu_color_space = .srgb,
        .gpu_vsync = true,
    },
    .{
        .label = primary_editor_view_label,
        .kind = .webview,
        .parent = canvas_label,
        .x = 0,
        .y = 0,
        .width = 1,
        .height = 1,
        .layer = 20,
        .url = "zero://app/index.html?project=0&slot=0&theme=system",
    },
    .{
        .label = secondary_editor_view_label,
        .kind = .webview,
        .parent = canvas_label,
        .x = 0,
        .y = 0,
        .width = 1,
        .height = 1,
        .layer = 20,
        .url = "zero://app/index.html?project=0&slot=0&theme=system",
    },
    .{
        .label = tree_view_label,
        .kind = .webview,
        .parent = canvas_label,
        .x = 0,
        .y = 0,
        .width = 1,
        .height = 1,
        .layer = 18,
        .url = "zero://app/tree.html?project=0&theme=system",
    },
};

const shell_windows = [_]native_sdk.ShellWindow{.{
    .label = "main",
    .title = "Docyrus Open IDE",
    .width = window_width,
    .height = window_height,
    .min_width = 1024,
    .min_height = 700,
    .titlebar = .hidden_inset,
    .restore_state = true,
    .views = &shell_views,
}};

pub const shell_scene: native_sdk.ShellConfig = .{ .windows = &shell_windows };

pub fn appOptions(io: std.Io) DocyrusApp.Options {
    return .{
        .name = "docyrus-open-ide",
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .update_fx = update,
        .init_fx = boot,
        .view = CompiledAppView.build,
        .markup = if (builtin.mode == .Debug) .{ .source = app_markup, .watch_path = "src/app.native", .io = io } else null,
        .web_panes = webPanes,
        .theme_state_fn = themeState,
    };
}

const BridgePath = struct {
    path: []const u8,
};

const BridgeProjectSlot = struct {
    projectId: u32,
    slot: u32,
};

const BridgeWriteFile = struct {
    projectId: u32,
    slot: u32,
    content: []const u8,
};

const AppHost = struct {
    ui: *DocyrusApp,
    base: native_sdk.App,
    io: std.Io,
    runtime: ?*native_sdk.Runtime = null,
    preferences_path: [1024]u8 = undefined,
    preferences_path_len: usize = 0,

    fn app(self: *AppHost) native_sdk.App {
        return .{
            .context = self,
            .name = self.base.name,
            .source = self.base.source,
            .scene_fn = sceneFn,
            .start_fn = startFn,
            .event_fn = eventFn,
            .stop_fn = stopFn,
            .replay_fn = replayFn,
        };
    }

    fn startFn(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *AppHost = @ptrCast(@alignCast(context));
        self.runtime = runtime;
        self.base.start(runtime) catch |err| {
            std.log.err("base UI start failed: {s}", .{@errorName(err)});
            return err;
        };
    }

    fn eventFn(context: *anyopaque, runtime: *native_sdk.Runtime, event: native_sdk.Event) anyerror!void {
        const self: *AppHost = @ptrCast(@alignCast(context));
        try self.base.event(runtime, event);
        if (self.ui.model.directory_picker_requested) try self.showDirectoryPicker(runtime);
        if (self.ui.model.project_switching) try self.ui.dispatch(runtime, 1, .finish_project_switch);
    }

    fn sceneFn(context: *anyopaque) anyerror!native_sdk.ShellConfig {
        const self: *AppHost = @ptrCast(@alignCast(context));
        return (try self.base.scene()) orelse shell_scene;
    }

    fn stopFn(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *AppHost = @ptrCast(@alignCast(context));
        self.savePreferences();
        self.runtime = null;
        try self.base.stop(runtime);
    }

    fn replayFn(context: *anyopaque, control: native_sdk.runtime.ReplayControl) anyerror!void {
        const self: *AppHost = @ptrCast(@alignCast(context));
        try self.base.replayControl(control);
    }

    fn showDirectoryPicker(self: *AppHost, runtime: *native_sdk.Runtime) anyerror!void {
        self.ui.model.directory_picker_requested = false;
        var paths_buffer: [native_sdk.platform.max_dialog_paths_bytes]u8 = undefined;
        const result = runtime.showOpenDialog(.{
            .title = "Choose a project folder",
            .default_path = if (self.ui.model.active_project_id == 0) "" else self.ui.model.workspace_path(),
            .allow_directories = true,
            .allow_multiple = false,
        }, &paths_buffer) catch {
            try self.ui.dispatch(runtime, 1, .directory_picker_cancelled);
            return;
        };
        if (result.count == 0 or result.paths.len == 0) {
            try self.ui.dispatch(runtime, 1, .directory_picker_cancelled);
            return;
        }
        const end = std.mem.indexOfScalar(u8, result.paths, '\n') orelse result.paths.len;
        try self.ui.dispatch(runtime, 1, .{ .directory_selected = result.paths[0..end] });
    }

    fn savePreferences(self: *AppHost) void {
        if (self.preferences_path_len == 0) return;
        var buffer: [12 * 1024]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&buffer);
        writer.print("theme={s}\n", .{themeName(self.ui.model.theme_mode)}) catch return;
        for (self.ui.model.recent_projects[0..self.ui.model.recent_count]) |*recent| writer.print("recent={s}\n", .{recent.path()}) catch return;
        std.Io.Dir.cwd().writeFile(self.io, .{ .sub_path = self.preferences_path[0..self.preferences_path_len], .data = writer.buffered() }) catch {};
    }

    fn validateBridgeProject(self: *AppHost, project_id: u32) !*ProjectState {
        if (project_id == 0 or project_id > self.ui.model.project_count) return error.UnknownProject;
        if (project_id != self.ui.model.active_project_id) return error.InactiveProject;
        return &self.ui.model.projects[project_id - 1];
    }

    fn activeBridgeProject(self: *AppHost) !struct { id: u32, project: *ProjectState } {
        const project_id = self.ui.model.active_project_id;
        if (project_id == 0 or project_id > self.ui.model.project_count) return error.UnknownProject;
        return .{ .id = project_id, .project = &self.ui.model.projects[project_id - 1] };
    }

    fn listTree(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *AppHost = @ptrCast(@alignCast(context));
        if (!std.mem.eql(u8, invocation.source.webview_label, tree_view_label)) return error.InvalidBridgeSource;
        const parsed = try std.json.parseFromSlice(BridgeTreePage, std.heap.page_allocator, invocation.request.payload, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const active = try self.activeBridgeProject();
        return writeProjectTreeJson(self.io, active.project.path(), parsed.value.offset, output);
    }

    fn openPath(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *AppHost = @ptrCast(@alignCast(context));
        if (!std.mem.eql(u8, invocation.source.webview_label, tree_view_label)) return error.InvalidBridgeSource;
        const parsed = try std.json.parseFromSlice(BridgePath, std.heap.page_allocator, invocation.request.payload, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        if (!isSafeRelativePath(parsed.value.path) or std.mem.endsWith(u8, parsed.value.path, "/")) return error.InvalidPath;
        const active = try self.activeBridgeProject();
        const project = active.project;
        var absolute_buffer: [2048]u8 = undefined;
        const absolute = try fullPath(project, parsed.value.path, &absolute_buffer);
        var markdown: []u8 = &.{};
        if (fileKind(parsed.value.path) == .markdown) {
            markdown = std.Io.Dir.cwd().readFileAlloc(self.io, absolute, std.heap.page_allocator, .limited(markdown_capacity)) catch &.{};
        }
        defer if (markdown.len > 0) std.heap.page_allocator.free(markdown);
        const runtime = self.runtime orelse return error.RuntimeNotReady;
        try self.ui.dispatch(runtime, invocation.source.window_id, .{ .open_file = .{ .project_id = active.id, .path = parsed.value.path, .markdown = markdown } });
        var writer: std.Io.Writer = .fixed(output);
        try writer.writeAll("true");
        return writer.buffered();
    }

    fn readFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *AppHost = @ptrCast(@alignCast(context));
        if (!isEditorView(invocation.source.webview_label)) return error.InvalidBridgeSource;
        const parsed = try std.json.parseFromSlice(BridgeProjectSlot, std.heap.page_allocator, invocation.request.payload, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const project = try self.validateBridgeProject(parsed.value.projectId);
        if (parsed.value.slot < 1 or parsed.value.slot > max_file_tabs) return error.UnknownTab;
        const tab = &project.layout.file_tabs[parsed.value.slot - 1];
        if (!tab.used) return error.UnknownTab;
        var absolute_buffer: [2048]u8 = undefined;
        const absolute = try fullPath(project, tab.path(), &absolute_buffer);
        const content = try std.Io.Dir.cwd().readFileAlloc(self.io, absolute, std.heap.page_allocator, .limited(bridge_file_limit));
        defer std.heap.page_allocator.free(content);
        var writer: std.Io.Writer = .fixed(output);
        try std.json.Stringify.value(.{ .path = absolute, .relativePath = tab.path(), .content = content }, .{}, &writer);
        return writer.buffered();
    }

    fn writeFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *AppHost = @ptrCast(@alignCast(context));
        if (!isEditorView(invocation.source.webview_label)) return error.InvalidBridgeSource;
        const parsed = try std.json.parseFromSlice(BridgeWriteFile, std.heap.page_allocator, invocation.request.payload, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        if (parsed.value.content.len > bridge_file_limit) return error.FileTooLarge;
        const project = try self.validateBridgeProject(parsed.value.projectId);
        if (parsed.value.slot < 1 or parsed.value.slot > max_file_tabs) return error.UnknownTab;
        const tab = &project.layout.file_tabs[parsed.value.slot - 1];
        if (!tab.used or tab.kind == .image) return error.UnknownTab;
        var absolute_buffer: [2048]u8 = undefined;
        const absolute = try fullPath(project, tab.path(), &absolute_buffer);
        try std.Io.Dir.cwd().writeFile(self.io, .{ .sub_path = absolute, .data = parsed.value.content });
        if (tab.kind == .markdown) {
            const runtime = self.runtime orelse return error.RuntimeNotReady;
            try self.ui.dispatch(runtime, invocation.source.window_id, .{ .markdown_saved = .{ .project_id = parsed.value.projectId, .slot = parsed.value.slot, .content = parsed.value.content } });
        }
        var writer: std.Io.Writer = .fixed(output);
        try writer.writeAll("true");
        return writer.buffered();
    }
};

fn isEditorView(label: []const u8) bool {
    return std.mem.eql(u8, label, primary_editor_view_label) or std.mem.eql(u8, label, secondary_editor_view_label);
}

fn ignoredDirectory(name: []const u8) bool {
    const ignored = [_][]const u8{ ".git", ".zig-cache", ".native", "node_modules", "zig-out", "zig-pkg", ".next", ".turbo" };
    for (ignored) |candidate| if (std.mem.eql(u8, name, candidate)) return true;
    return false;
}

const BridgeTreePage = struct {
    offset: usize = 0,
};

fn writeProjectTreeJson(io: std.Io, project_path: []const u8, offset: usize, output: []u8) ![]const u8 {
    if (!std.fs.path.isAbsolute(project_path)) return error.InvalidProjectPath;
    if (offset > bridge_tree_limit) return error.InvalidTreeOffset;

    // Open the selected root explicitly. Never let an empty or relative path
    // fall through to the process working directory inside an app bundle.
    var directory = try std.Io.Dir.openDirAbsolute(io, project_path, .{ .iterate = true });
    defer directory.close(io);
    var walker = try directory.walkSelectively(std.heap.page_allocator);
    defer {
        while (walker.stack.items.len > 1) walker.leave(io);
        walker.deinit();
    }

    var writer: std.Io.Writer = .fixed(output);
    try writer.writeAll("{\"root\":");
    try std.json.Stringify.value(project_path, .{}, &writer);
    try writer.writeAll(",\"paths\":[");

    var visited: usize = 0;
    var page_count: usize = 0;
    var skipped: usize = 0;
    var reached_end = false;
    var first = true;
    while (visited < bridge_tree_limit) {
        const entry = walker.next(io) catch {
            // An unreadable descendant must not discard files already found in
            // the selected project. Return the useful partial tree instead.
            skipped += 1;
            reached_end = true;
            break;
        } orelse {
            reached_end = true;
            break;
        };

        if (entry.kind == .directory and ignoredDirectory(entry.basename)) continue;
        if (entry.path.len > relative_path_capacity - 2) {
            skipped += 1;
            continue;
        }

        var path_buffer: [relative_path_capacity]u8 = undefined;
        const path = if (entry.kind == .directory)
            try std.fmt.bufPrint(&path_buffer, "{s}/", .{entry.path})
        else
            entry.path;

        if (visited < offset) {
            visited += 1;
            if (entry.kind == .directory) {
                walker.enter(io, entry) catch {
                    skipped += 1;
                    continue;
                };
            }
            continue;
        }

        if (page_count >= bridge_tree_page_limit) break;

        // Encode one path separately so the page can stop before it exceeds
        // the bridge's response limit, including JSON escaping expansion.
        var encoded_buffer: [relative_path_capacity * 6 + 2]u8 = undefined;
        var encoded_writer: std.Io.Writer = .fixed(&encoded_buffer);
        try std.json.Stringify.value(path, .{}, &encoded_writer);
        const encoded = encoded_writer.buffered();
        const response_budget = @min(output.len, bridge_tree_page_budget);
        if (writer.buffered().len + encoded.len + 160 > response_budget) break;

        if (!first) try writer.writeByte(',');
        first = false;
        try writer.writeAll(encoded);
        visited += 1;
        page_count += 1;
        if (entry.kind == .directory) {
            walker.enter(io, entry) catch {
                skipped += 1;
                continue;
            };
        }
    }

    const next_offset = offset + page_count;
    const truncated = next_offset >= bridge_tree_limit and !reached_end;
    const done = reached_end or truncated;

    try writer.writeAll("],\"nextOffset\":");
    try writer.print("{d}", .{next_offset});
    try writer.writeAll(",\"done\":");
    try writer.writeAll(if (done) "true" else "false");
    try writer.writeAll(",\"truncated\":");
    try writer.writeAll(if (truncated) "true" else "false");
    try writer.writeAll(",\"skipped\":");
    try writer.print("{d}", .{skipped});
    try writer.writeByte('}');
    return writer.buffered();
}

fn loadPreferences(model: *Model, io: std.Io, path: []const u8) void {
    const content = std.Io.Dir.cwd().readFileAlloc(io, path, std.heap.page_allocator, .limited(12 * 1024)) catch return;
    defer std.heap.page_allocator.free(content);
    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "theme=")) {
            const value = line[6..];
            if (std.mem.eql(u8, value, "light")) model.theme_mode = .light else if (std.mem.eql(u8, value, "dark")) model.theme_mode = .dark else model.theme_mode = .system;
        } else if (std.mem.startsWith(u8, line, "recent=")) {
            addRecentProject(model, line[7..]);
        }
    }
}

fn resolvePreferencesPath(init: std.process.Init, output: []u8) ?[]const u8 {
    var directory_buffer: [768]u8 = undefined;
    const directory = native_sdk.app_dirs.resolveOne(
        .{ .name = bundle_id },
        native_sdk.app_dirs.currentPlatform(),
        native_sdk.debug.envFromMap(init.environ_map),
        .data,
        &directory_buffer,
    ) catch return null;
    std.Io.Dir.cwd().createDirPath(init.io, directory) catch return null;
    return std.fmt.bufPrint(output, "{s}/preferences.txt", .{directory}) catch null;
}

pub fn main(init: std.process.Init) !void {
    var initial_model: Model = .{};
    var preferences_path: [1024]u8 = undefined;
    const resolved_preferences = resolvePreferencesPath(init, &preferences_path);
    if (resolved_preferences) |path| loadPreferences(&initial_model, init.io, path);
    if (init.environ_map.get("DOCYRUS_OPEN_IDE_E2E_PROJECT")) |path| {
        initial_model.active_project_id = addProject(&initial_model, path) orelse 0;
    }
    if (init.environ_map.get("DOCYRUS_OPEN_IDE_E2E_RECENT")) |path| addRecentProject(&initial_model, path);
    syncUrls(&initial_model);

    const app_state = try std.heap.page_allocator.create(DocyrusApp);
    defer std.heap.page_allocator.destroy(app_state);
    app_state.* = DocyrusApp.init(std.heap.page_allocator, initial_model, appOptions(init.io));
    defer app_state.deinit();

    var base = app_state.app();
    base.source = native_sdk.WebViewSource.assets(.{
        .root_path = "frontend/dist",
        .entry = "index.html",
        .origin = "zero://app",
        .spa_fallback = true,
    });
    var host: AppHost = .{ .ui = app_state, .base = base, .io = init.io };
    if (resolved_preferences) |path| {
        host.preferences_path_len = path.len;
        @memcpy(host.preferences_path[0..path.len], path);
    }
    const app = host.app();

    const bridge_policies = [_]native_sdk.bridge.CommandPolicy{
        .{ .name = "workspace.listTree", .permissions = &.{native_sdk.security.permission_filesystem}, .origins = &.{"zero://app"} },
        .{ .name = "workspace.openPath", .permissions = &.{native_sdk.security.permission_filesystem}, .origins = &.{"zero://app"} },
        .{ .name = "workspace.readFile", .permissions = &.{native_sdk.security.permission_filesystem}, .origins = &.{"zero://app"} },
        .{ .name = "workspace.writeFile", .permissions = &.{native_sdk.security.permission_filesystem}, .origins = &.{"zero://app"} },
    };
    const bridge_handlers = [_]native_sdk.bridge.Handler{
        .{ .name = "workspace.listTree", .context = &host, .invoke_fn = AppHost.listTree },
        .{ .name = "workspace.openPath", .context = &host, .invoke_fn = AppHost.openPath },
        .{ .name = "workspace.readFile", .context = &host, .invoke_fn = AppHost.readFile },
        .{ .name = "workspace.writeFile", .context = &host, .invoke_fn = AppHost.writeFile },
    };

    try runner.runWithOptions(app, .{
        .app_name = "docyrus-open-ide",
        .window_title = "Docyrus Open IDE",
        .bundle_id = bundle_id,
        .default_frame = geometry.RectF.init(0, 0, window_width, window_height),
        .js_window_api = false,
        .bridge = .{
            .policy = .{ .enabled = true, .permissions = &app_permissions, .commands = &bridge_policies },
            .registry = .{ .handlers = &bridge_handlers },
        },
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{ .allowed_origins = &.{ "zero://app", "zero://inline" }, .external_links = .{ .action = .deny } },
        },
    }, init);
}
