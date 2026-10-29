const std = @import("std");
const remote = @import("remote.zig");

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
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
