const std = @import("std");
const remote = @import("remote.zig");

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len == 6 and std.mem.eql(u8, args[1], "--auth")) return testAuthentication(args, init.io);
    if (args.len != 6) return error.ExpectedUrlAndFourHomes;
    var message: [512]u8 = @splat(0);
    if (remote.Client.connect(args[1], args[3], &message)) |unexpected| {
        var client = unexpected;
        client.deinit();
        return error.UnknownHostAccepted;
    } else |_| {}
    if (std.mem.indexOf(u8, std.mem.sliceTo(&message, 0), "not trusted") == null) {
        std.debug.print("Unknown host test: {s}\n", .{std.mem.sliceTo(&message, 0)});
        return error.UnexpectedConnectionFailure;
    }
    @memset(&message, 0);
    if (remote.Client.connect(args[1], args[4], &message)) |unexpected| {
        var client = unexpected;
        client.deinit();
        return error.ChangedHostAccepted;
    } else |_| {}
    try require(std.mem.indexOf(u8, std.mem.sliceTo(&message, 0), "has changed") != null);
    @memset(&message, 0);
    if (remote.Client.connect(args[1], args[5], &message)) |unexpected| {
        var invalid = unexpected;
        invalid.deinit();
        return error.RevokedHostAccepted;
    } else |_| {}
    try require(std.mem.indexOf(u8, std.mem.sliceTo(&message, 0), "revoked") != null);

    var client = remote.Client.connect(args[1], args[2], &message) catch |err| {
        std.debug.print("SSH connect: {s}\n", .{std.mem.sliceTo(&message, 0)});
        return err;
    };
    defer client.deinit();
    try require(try client.stat(""));
    const content = try client.read("hello.txt", 1024);
    defer std.heap.page_allocator.free(content);
    try require(std.mem.eql(u8, content, "Hello over SFTP!\n"));
    try expectFailure(error.FileTooLarge, client.read("hello.txt", 2));
    try expectFailure(error.UnsafeRemotePath, client.read("../outside.txt", 1024));
    try expectFailure(error.UnsafeRemotePath, client.read("escape/outside.txt", 1024));
    try expectFailure(error.UnsafeRemotePath, client.stat("escape"));
    try client.create("nested/deep/notes 'quoted'.txt", false);
    try expectFailure(error.PathAlreadyExists, client.create("nested/deep/notes 'quoted'.txt", false));
    try client.write("nested/deep/notes 'quoted'.txt", "Saved atomically: 你好\n", false);
    const saved = try client.read("nested/deep/notes 'quoted'.txt", 1024);
    defer std.heap.page_allocator.free(saved);
    try require(std.mem.eql(u8, saved, "Saved atomically: 你好\n"));
    try client.move("nested/deep/notes 'quoted'.txt", "nested/done.txt");
    try expectFailure(error.InvalidPath, client.move("nested", "nested/inner"));
    try client.copy("nested", "copy");
    const copied = try client.read("copy/done.txt", 1024);
    defer std.heap.page_allocator.free(copied);
    try require(std.mem.eql(u8, copied, saved));
    try expectFailure(error.PathAlreadyExists, client.copy("hello.txt", "copy/done.txt"));
    var listing = try client.list("", true);
    defer listing.deinit();
    try require(listing.skipped > 0); // symlink omitted
    for (listing.entries.items) |entry| try require(!std.mem.startsWith(u8, entry.path, "escape"));
    try client.remove("copy");
    try client.remove("nested");
    try expectFailure(error.FileNotFound, client.stat("copy"));
    try expectFailure(error.InvalidPath, client.remove(""));
    try client.write("hello.txt", "", false);
    const empty = try client.read("hello.txt", 0);
    defer std.heap.page_allocator.free(empty);
    try require(empty.len == 0);
    std.debug.print("SSH/SFTP integration passed: trust, agent auth, read/save, folders, copy/move/delete, limits, symlinks.\n", .{});
}

const AuthReplies = struct {
    calls: usize = 0,
    bad_password: bool = false,
    cancel_at: usize = 0,
    io: ?std.Io = null,
    delay_first_ms: i64 = 0,
};

fn authReply(context: ?*anyopaque, user: [*c]const u8, host: [*c]const u8, instruction: [*c]const u8, question: [*c]const u8, response: [*c]u8, capacity: usize) callconv(.c) c_int {
    _ = instruction;
    _ = question;
    const state: *AuthReplies = @ptrCast(@alignCast(context.?));
    state.calls += 1;
    if (state.calls == 1 and state.delay_first_ms > 0) std.Io.sleep(state.io.?, .fromMilliseconds(state.delay_first_ms), .awake) catch return 0;
    if (!std.mem.eql(u8, std.mem.span(user), "test-user") or !std.mem.eql(u8, std.mem.span(host), "127.0.0.1")) return 0;
    if (state.cancel_at == state.calls) return 0;
    const answer = if (state.bad_password) "incorrect" else if (state.calls == 2) "654321" else "sftp-test-pässword";
    if (answer.len >= capacity) return 0;
    @memcpy(response[0..answer.len], answer);
    response[answer.len] = 0;
    return 1;
}

fn testAuthentication(args: []const [:0]const u8, io: std.Io) !void {
    const uri = args[2];
    const home = args[3];
    var message: [512]u8 = @splat(0);
    var replies: AuthReplies = .{};
    try expectFailure(error.PasswordAuthenticationRequired, remote.Client.connect(uri, home, &message));
    try expectFailure(error.RemoteConnectionFailed, remote.Client.connectWithPrompt(uri, args[4], &message, authReply, &replies));
    try require(replies.calls == 0); // untrusted hosts must not ask for secrets
    replies = .{ .cancel_at = 1 };
    try expectFailure(error.AuthenticationCancelled, remote.Client.connectWithPrompt(uri, home, &message, authReply, &replies));
    try require(replies.calls == 1);
    replies = .{ .bad_password = true };
    try expectFailure(error.RemoteConnectionFailed, remote.Client.connectWithPrompt(uri, home, &message, authReply, &replies));
    try require(std.mem.indexOf(u8, std.mem.sliceTo(&message, 0), "incorrect") == null);
    replies = .{};
    var client = remote.Client.connectWithPrompt(uri, home, &message, authReply, &replies) catch |err| {
        std.debug.print("Authentication test: {s}\n", .{std.mem.sliceTo(&message, 0)});
        return err;
    };
    defer client.deinit();
    try require(replies.calls == (if (std.mem.eql(u8, args[5], "keyboard-interactive")) @as(usize, 2) else 1));
    const content = try client.read("hello.txt", 1024);
    defer std.heap.page_allocator.free(content);
    try require(std.mem.eql(u8, content, "Authenticated SFTP\n"));
    // A later connection needs fresh input; no password is cached in Client.
    try expectFailure(error.PasswordAuthenticationRequired, remote.Client.connect(uri, home, &message));
    if (std.mem.eql(u8, args[5], "keyboard-interactive")) {
        replies = .{ .cancel_at = 2 };
        try expectFailure(error.AuthenticationCancelled, remote.Client.connectWithPrompt(uri, home, &message, authReply, &replies));
        try require(replies.calls == 2);
        replies = .{ .io = io, .delay_first_ms = 11000 };
        var delayed = try remote.Client.connectWithPrompt(uri, home, &message, authReply, &replies);
        delayed.deinit();
    }
    std.debug.print("SSH {s} authentication passed: success, rejection, cancellation, trust checks, and no password caching.\n", .{args[5]});
}

fn require(condition: bool) !void {
    if (!condition) return error.IntegrationAssertionFailed;
}
fn expectFailure(expected: anyerror, result: anytype) !void {
    if (result) |_| return error.ExpectedFailure else |actual| {
        if (actual != expected) {
            std.debug.print("expected {t}, received {t}\n", .{ expected, actual });
            return actual;
        }
    }
}
