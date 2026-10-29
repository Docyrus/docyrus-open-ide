const std = @import("std");
pub const c = @cImport({
    @cInclude("remote_client.h");
});
const allocator = std.heap.page_allocator;
pub const max_entries = 4096;
pub const max_path = 768;
pub const max_file_bytes = 768 * 1024;

pub const Config = struct {
    host: [256:0]u8 = @splat(0),
    user: [128:0]u8 = @splat(0),
    root: [1024:0]u8 = @splat(0),
    port_text: [6:0]u8 = @splat(0),
    port: u16 = 22,

    pub fn parse(uri: []const u8) !Config {
        const start: usize = if (std.mem.startsWith(u8, uri, "ssh://")) 6 else if (std.mem.startsWith(u8, uri, "sftp://")) 7 else return error.InvalidRemoteUrl;
        if (uri.len > 1024 or std.mem.indexOfAny(u8, uri, "\x00\r\n\t\\?#") != null) return error.InvalidRemoteUrl;
        const slash = std.mem.indexOfScalarPos(u8, uri, start, '/') orelse return error.RemoteFolderRequired;
        const authority = uri[start..slash];
        const at = std.mem.indexOfScalar(u8, authority, '@') orelse return error.RemoteUsernameRequired;
        const user = authority[0..at];
        if (user.len == 0 or user.len >= 128 or std.mem.indexOfAny(u8, user, ":@% ") != null or user[0] == '-') return error.InvalidRemoteUrl;
        var host = authority[at + 1 ..];
        var port: u16 = 22;
        if (host.len > 0 and host[0] == '[') {
            const close = std.mem.indexOfScalar(u8, host, ']') orelse return error.InvalidRemoteUrl;
            const suffix = host[close + 1 ..];
            if (suffix.len > 0) {
                if (suffix[0] != ':' or suffix.len < 2) return error.InvalidRemoteUrl;
                port = std.fmt.parseInt(u16, suffix[1..], 10) catch return error.InvalidRemotePort;
            }
            host = host[1..close];
            if (std.mem.indexOfScalar(u8, host, ':') == null) return error.InvalidRemoteUrl;
        } else if (std.mem.indexOfScalar(u8, host, ':')) |colon| {
            port = std.fmt.parseInt(u16, host[colon + 1 ..], 10) catch return error.InvalidRemotePort;
            host = host[0..colon];
        }
        if (port == 0 or host.len == 0 or host.len >= 256 or host[0] == '-' or std.mem.indexOfAny(u8, host, "@[]% ") != null) return error.InvalidRemoteUrl;
        for (host) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, ".-:_", byte) == null) return error.InvalidRemoteUrl;
        for (user) |byte| if (byte < 33 or byte == 127) return error.InvalidRemoteUrl;
        var config: Config = .{ .port = port };
        @memcpy(config.host[0..host.len], host);
        @memcpy(config.user[0..user.len], user);
        _ = try std.fmt.bufPrint(&config.port_text, "{d}", .{port});
        var length: usize = 0;
        var i = slash;
        while (i < uri.len) : (i += 1) {
            var byte = uri[i];
            if (byte == '%') {
                if (i + 2 >= uri.len) return error.InvalidRemoteUrl;
                byte = std.fmt.parseInt(u8, uri[i + 1 .. i + 3], 16) catch return error.InvalidRemoteUrl;
                i += 2;
            }
            if (byte < 32 or byte == 127 or byte == '\\' or length >= config.root.len) return error.InvalidRemoteUrl;
            config.root[length] = byte;
            length += 1;
        }
        while (length > 1 and config.root[length - 1] == '/') : (length -= 1) config.root[length - 1] = 0;
        var components = std.mem.splitScalar(u8, config.root[0..length], '/');
        _ = components.next();
        while (components.next()) |part| {
            if (length > 1 and (part.len == 0 or std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, ".."))) return error.InvalidRemoteUrl;
        }
        return config;
    }
};

pub fn isRemote(path: []const u8) bool {
    return std.mem.startsWith(u8, path, "ssh://") or std.mem.startsWith(u8, path, "sftp://");
}

fn check(result: c_int) !void {
    return switch (result) {
        0 => {},
        c.DR_NOT_FOUND => error.FileNotFound,
        c.DR_EXISTS => error.PathAlreadyExists,
        c.DR_UNSAFE => error.UnsafeRemotePath,
        c.DR_TOO_LARGE => error.FileTooLarge,
        else => error.RemoteOperationFailed,
    };
}

fn pathZ(path: []const u8, buffer: *[max_path:0]u8) ![:0]const u8 {
    const trimmed = std.mem.trimEnd(u8, path, "/");
    if (trimmed.len >= max_path or std.mem.indexOfScalar(u8, trimmed, 0) != null) return error.InvalidPath;
    @memcpy(buffer[0..trimmed.len], trimmed);
    buffer[trimmed.len] = 0;
    return buffer[0..trimmed.len :0];
}

pub const Entry = struct { path: []const u8, directory: bool };
pub const Listing = struct {
    arena: std.heap.ArenaAllocator = .init(allocator),
    entries: std.ArrayList(Entry) = .empty,
    truncated: bool = false,
    skipped: usize = 0,
    pub fn deinit(self: *Listing) void {
        self.arena.deinit();
    }
};

pub const Client = struct {
    handle: *c.DocyrusRemote,
    uri: [1025:0]u8 = @splat(0),
    tree: ?Listing = null,

    pub fn connect(uri: []const u8, home: []const u8, message: []u8) !Client {
        const config = try Config.parse(uri);
        var known: [2048]u8 = undefined;
        const known_hosts = try std.fmt.bufPrintZ(&known, "{s}/.ssh/known_hosts", .{home});
        if (message.len == 0) return error.InvalidBuffer;
        const handle = c.dr_connect(&config.host, config.port, &config.user, &config.root, known_hosts, message.ptr, message.len) orelse return error.RemoteConnectionFailed;
        var client: Client = .{ .handle = handle };
        @memcpy(client.uri[0..uri.len], uri);
        return client;
    }
    pub fn deinit(self: *Client) void {
        if (self.tree) |*tree| tree.deinit();
        c.dr_disconnect(self.handle);
    }
    pub fn stat(self: *Client, path: []const u8) !bool {
        var buffer: [max_path:0]u8 = undefined;
        var directory: c_int = 0;
        try check(c.dr_stat(self.handle, try pathZ(path, &buffer), &directory));
        return directory != 0;
    }
    pub fn read(self: *Client, path: []const u8, limit: usize) ![]u8 {
        var buffer: [max_path:0]u8 = undefined;
        const bytes = try allocator.alloc(u8, limit);
        errdefer allocator.free(bytes);
        var length: usize = 0;
        try check(c.dr_read(self.handle, try pathZ(path, &buffer), bytes.ptr, bytes.len, &length));
        // Return an exact allocation so callers can use the ordinary allocator.free.
        const result = try allocator.dupe(u8, bytes[0..length]);
        allocator.free(bytes);
        return result;
    }
    pub fn write(self: *Client, path: []const u8, data: []const u8, exclusive: bool) !void {
        var buffer: [max_path:0]u8 = undefined;
        if (data.len > max_file_bytes) return error.FileTooLarge;
        try check(c.dr_write(self.handle, try pathZ(path, &buffer), data.ptr, data.len, @intFromBool(exclusive)));
    }
    pub fn mkdir(self: *Client, path: []const u8) !void {
        var buffer: [max_path:0]u8 = undefined;
        try check(c.dr_mkdir(self.handle, try pathZ(path, &buffer)));
    }
    pub fn parents(self: *Client, path: []const u8) !void {
        for (path, 0..) |byte, i| {
            if (byte != '/' or i == 0) continue;
            const directory = self.stat(path[0..i]) catch |err| switch (err) {
                error.FileNotFound => {
                    try self.mkdir(path[0..i]);
                    continue;
                },
                else => return err,
            };
            if (!directory) return error.InvalidPath;
        }
    }
    pub fn create(self: *Client, path: []const u8, directory: bool) !void {
        const trimmed = std.mem.trimEnd(u8, path, "/");
        if (trimmed.len == 0) return error.InvalidPath;
        if (self.stat(trimmed)) |_| return error.PathAlreadyExists else |err| if (err != error.FileNotFound) return err;
        try self.parents(trimmed);
        if (directory) try self.mkdir(trimmed) else try self.write(trimmed, "", true);
    }
    pub fn move(self: *Client, from: []const u8, to: []const u8) !void {
        const source = std.mem.trimEnd(u8, from, "/");
        const destination = std.mem.trimEnd(u8, to, "/");
        if (std.mem.eql(u8, source, destination)) return;
        if (inside(destination, source)) return error.InvalidPath;
        try self.parents(destination);
        var a: [max_path:0]u8 = undefined;
        var b: [max_path:0]u8 = undefined;
        try check(c.dr_rename(self.handle, try pathZ(source, &a), try pathZ(destination, &b)));
    }
    pub fn list(self: *Client, path: []const u8, filtered: bool) !Listing {
        var listing: Listing = .{};
        errdefer listing.deinit();
        try self.walk(&listing, path, filtered, 0);
        return listing;
    }
    fn walk(self: *Client, listing: *Listing, path: []const u8, filtered: bool, depth: usize) anyerror!void {
        if (depth >= 32) {
            listing.truncated = true;
            return;
        }
        var buffer: [max_path:0]u8 = undefined;
        const handle = c.dr_opendir(self.handle, try pathZ(path, &buffer)) orelse return error.RemoteDirectoryUnavailable;
        defer c.dr_closedir(handle);
        var visits: usize = 0;
        while (true) {
            var name: [max_path:0]u8 = undefined;
            var directory: c_int = -1;
            const result = c.dr_readdir(self.handle, handle, &name, name.len, &directory);
            if (result < 0) return error.RemoteOperationFailed;
            if (result == 0) break;
            visits += 1;
            if (visits > max_entries or listing.entries.items.len >= max_entries) {
                listing.truncated = true;
                break;
            }
            const base = std.mem.sliceTo(&name, 0);
            if (std.mem.eql(u8, base, ".") or std.mem.eql(u8, base, "..")) continue;
            if (result == 2 or directory < 0 or std.mem.indexOfAny(u8, base, "/\\\x00\r\n") != null) {
                listing.skipped += 1;
                continue;
            }
            if (filtered and directory == 1 and ignored(base)) continue;
            const arena = listing.arena.allocator();
            const child = if (path.len == 0) try arena.dupe(u8, base) else try std.fmt.allocPrint(arena, "{s}/{s}", .{ path, base });
            if (child.len >= max_path - 2) {
                listing.skipped += 1;
                continue;
            }
            try listing.entries.append(arena, .{ .path = child, .directory = directory == 1 });
            if (directory == 1) try self.walk(listing, child, filtered, depth + 1);
        }
    }
    pub fn remove(self: *Client, path: []const u8) !void {
        const trimmed = std.mem.trimEnd(u8, path, "/");
        if (trimmed.len == 0) return error.InvalidPath;
        const directory = try self.stat(trimmed);
        if (directory) {
            var listing = try self.list(trimmed, false);
            defer listing.deinit();
            // Do not start a recursive deletion with an incomplete snapshot.
            if (listing.truncated or listing.skipped > 0) return error.RemoteTreeIncomplete;
            var i = listing.entries.items.len;
            while (i > 0) {
                i -= 1;
                const entry = listing.entries.items[i];
                try self.removeOne(entry.path, entry.directory);
            }
        }
        try self.removeOne(trimmed, directory);
    }
    fn removeOne(self: *Client, path: []const u8, directory: bool) !void {
        var buffer: [max_path:0]u8 = undefined;
        try check(c.dr_remove(self.handle, try pathZ(path, &buffer), @intFromBool(directory)));
    }
    pub fn copy(self: *Client, source: []const u8, destination: []const u8) !void {
        const directory = try self.stat(source);
        if (std.mem.eql(u8, source, destination) or inside(destination, source)) return error.InvalidPath;
        if (!directory) {
            const content = try self.read(source, max_file_bytes);
            defer allocator.free(content);
            try self.parents(destination);
            return self.write(destination, content, true);
        }
        var listing = try self.list(source, false);
        defer listing.deinit();
        if (listing.truncated or listing.skipped > 0) return error.RemoteTreeIncomplete;
        try self.create(destination, true);
        for (listing.entries.items) |entry| {
            var target_buffer: [max_path]u8 = undefined;
            const target = try std.fmt.bufPrint(&target_buffer, "{s}{s}", .{ destination, entry.path[source.len..] });
            if (entry.directory) try self.mkdir(target) else {
                const content = try self.read(entry.path, max_file_bytes);
                defer allocator.free(content);
                try self.write(target, content, true);
            }
        }
    }
};

fn inside(path: []const u8, parent: []const u8) bool {
    return path.len > parent.len and std.mem.startsWith(u8, path, parent) and path[parent.len] == '/';
}
fn ignored(name: []const u8) bool {
    for ([_][]const u8{ ".git", "node_modules", ".zig-cache", "zig-out", "zig-pkg", ".native", ".next", "vendor" }) |value| if (std.mem.eql(u8, value, name)) return true;
    return false;
}

pub const Manager = struct {
    clients: [10]?Client = @splat(null),
    pub fn deinit(self: *Manager) void {
        for (&self.clients) |*slot| if (slot.*) |*client| {
            client.deinit();
            slot.* = null;
        };
    }
    pub fn get(self: *Manager, uri: []const u8, home: []const u8, message: []u8) !*Client {
        for (&self.clients) |*slot| if (slot.*) |*client| {
            if (std.mem.eql(u8, std.mem.sliceTo(&client.uri, 0), uri)) {
                if (c.dr_alive(client.handle) != 0) return client;
                client.deinit();
                slot.* = null;
                break;
            }
        };
        for (&self.clients) |*slot| if (slot.* == null) {
            slot.* = try Client.connect(uri, home, message);
            return &slot.*.?;
        };
        return error.TooManyRemoteConnections;
    }
    pub fn close(self: *Manager, uri: []const u8) void {
        for (&self.clients) |*slot| if (slot.*) |*client| {
            if (std.mem.eql(u8, std.mem.sliceTo(&client.uri, 0), uri)) {
                client.deinit();
                slot.* = null;
            }
        };
    }
    pub fn adopt(self: *Manager, client: Client) !void {
        self.close(std.mem.sliceTo(&client.uri, 0));
        for (&self.clients) |*slot| if (slot.* == null) {
            slot.* = client;
            return;
        };
        return error.TooManyRemoteConnections;
    }
};

test "remote URLs parse ports, IPv6 and escaped folders without retaining secrets" {
    const config = try Config.parse("sftp://alice@[::1]:2222/home/alice/my%20project/");
    try std.testing.expectEqualStrings("::1", std.mem.sliceTo(&config.host, 0));
    try std.testing.expectEqualStrings("alice", std.mem.sliceTo(&config.user, 0));
    try std.testing.expectEqualStrings("/home/alice/my project", std.mem.sliceTo(&config.root, 0));
    try std.testing.expectEqual(@as(u16, 2222), config.port);
    _ = try Config.parse("ssh://alice@example.com/");
    for ([_][]const u8{ "ssh://alice:password@host/a", "ssh://host/a", "ssh://alice@host", "ssh://alice@host:0/a", "ssh://alice@host:65536/a", "ssh://alice@host/a/%2e%2e/b", "ssh://alice@host/a%00b", "ssh://alice@host/a?password=x", "ssh://alice@-oProxyCommand=bad/a" }) |uri| {
        if (Config.parse(uri)) |_| return error.UnsafeUrlAccepted else |_| {}
    }
}
