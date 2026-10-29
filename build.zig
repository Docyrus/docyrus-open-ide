//! This build belongs to your app, written once by `native eject`:
//! the `native` CLI stops generating a build graph and
//! drives this file through `zig build` instead, and it will
//! never rewrite it. `addApp` wires the complete standard app
//! build — executable, `zig build run`, `zig build test`, and
//! the -Dplatform/-Dweb-engine/-Dautomation/-Doptimize flags —
//! from the framework's build/app.zig, so a framework upgrade
//! still upgrades your build. Extend from here with
//! `addAppArtifacts` when you need extra sources or steps.

const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dep = b.dependency("native_sdk", .{});
    const app = native_sdk.addAppArtifacts(b, dep, .{
        .name = "docyrus-open-ide",
        .manifest = "app.json",
        .terminal_sessions = true,
    });
    addRemoteClient(b, app);
    addTerminalSessionTests(b, dep);
}

fn addRemoteClient(b: *std.Build, app: native_sdk.AppArtifacts) void {
    const objc_flags: []const []const u8 = if (b.sysroot) |sysroot|
        &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-ObjC", "-mmacosx-version-min=11.0", "-isysroot", sysroot, b.fmt("-I{s}/usr/include", .{sysroot}) }
    else
        &.{ "-fobjc-arc", "-mmacosx-version-min=11.0" };
    app.exe.root_module.addCSourceFile(.{ .file = b.path("src/remote_auth_prompt.m"), .flags = objc_flags });
    const ssh2 = b.dependency("libssh2", .{});
    const openssl = b.option([]const u8, "openssl-prefix", "OpenSSL 3 prefix (statically linked)") orelse "/opt/homebrew/opt/openssl@3";
    const module = b.createModule(.{
        .target = app.exe.root_module.resolved_target,
        .optimize = .ReleaseSafe,
        .link_libc = true,
    });
    module.addIncludePath(ssh2.path("include"));
    module.addIncludePath(ssh2.path("src"));
    module.addIncludePath(.{ .cwd_relative = b.pathJoin(&.{ openssl, "include" }) });
    module.addIncludePath(b.path("src"));
    module.addCSourceFiles(.{
        .root = ssh2.path("src"),
        .files = &.{ "agent.c", "bcrypt_pbkdf.c", "chacha.c", "channel.c", "cipher-chachapoly.c", "comp.c", "crypt.c", "global.c", "hostkey.c", "keepalive.c", "kex.c", "knownhost.c", "mac.c", "misc.c", "openssl.c", "packet.c", "pem.c", "poly1305.c", "publickey.c", "scp.c", "session.c", "sftp.c", "transport.c", "userauth.c", "userauth_kbd_packet.c", "version.c" },
        .flags = &.{ "-DLIBSSH2_OPENSSL", "-DHAVE_UNISTD_H", "-DHAVE_INTTYPES_H", "-DHAVE_SYS_UN_H", "-DHAVE_SYS_UIO_H", "-DHAVE_SYS_IOCTL_H", "-DHAVE_SYS_SELECT_H", "-DHAVE_POLL", "-DHAVE_O_NONBLOCK", "-DLIBSSH2_NO_DSA", "-DLIBSSH2_NO_RSA_SHA1", "-Wno-deprecated-declarations" },
    });
    module.addCSourceFile(.{ .file = b.path("src/remote_client.c"), .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror" } });
    const library = b.addLibrary(.{ .name = "docyrus-ssh2", .linkage = .static, .root_module = module });
    for ([_]*std.Build.Module{ app.exe.root_module, app.tests.root_module }) |root| {
        root.addIncludePath(b.path("src"));
        root.linkLibrary(library);
        root.addObjectFile(.{ .cwd_relative = b.pathJoin(&.{ openssl, "lib/libcrypto.a" }) });
    }
    const integration = b.addExecutable(.{ .name = "remote-integration", .root_module = b.createModule(.{
        .root_source_file = b.path("src/remote_integration.zig"),
        .target = app.exe.root_module.resolved_target,
        .optimize = .Debug,
        .link_libc = true,
    }) });
    integration.root_module.addIncludePath(b.path("src"));
    integration.root_module.linkLibrary(library);
    integration.root_module.addObjectFile(.{ .cwd_relative = b.pathJoin(&.{ openssl, "lib/libcrypto.a" }) });
    b.step("remote-test-client", "Build the isolated SSH/SFTP integration test client").dependOn(&b.addInstallArtifact(integration, .{}).step);
}

/// The framework's terminal-session store tests only have anything to
/// assert in a build that WIRES the emulator, and the framework's own
/// suite never does (it pins no ghostty), so every case skips there. This
/// app pins ghostty-vt, so `zig build test-terminal` runs them for real —
/// including the Docyrus wheel patches applied to the store. The module
/// graph mirrors the framework's own runtime wiring (build/app.zig,
/// `nativeSdkModuleWithTerminal`), restricted to what the runtime files
/// import by name.
fn addTerminalSessionTests(b: *std.Build, dep: *std.Build.Dependency) void {
    const target = b.resolveTargetQuery(.{});
    const optimize: std.builtin.OptimizeMode = .Debug;
    const ghostty = b.lazyDependency("ghostty", .{
        .target = target,
        .optimize = optimize,
        .simd = false,
        .@"emit-xcframework" = false,
        .@"emit-macos-app" = false,
    }) orelse return;

    const geometry = sdkModule(b, dep, target, optimize, "src/primitives/geometry/root.zig");
    const json = sdkModule(b, dep, target, optimize, "src/primitives/json/root.zig");
    const canvas = sdkModule(b, dep, target, optimize, "src/primitives/canvas/root.zig");
    canvas.addImport("geometry", geometry);
    canvas.addImport("json", json);
    const terminal_vt = sdkModule(b, dep, target, optimize, "src/runtime/terminal_vt_ghostty.zig");
    terminal_vt.addImport("ghostty-vt", ghostty.module("ghostty-vt"));

    const root = sdkModule(b, dep, target, optimize, "src/terminal_session_tests_root.zig");
    // The app build already resolved the macOS SDK sysroot. Library paths
    // are sysroot-prefixed by the linker; framework paths are not (the
    // framework's own link wiring spells the sysroot out).
    if (b.sysroot) |sysroot| {
        root.addLibraryPath(.{ .cwd_relative = "/usr/lib" });
        root.addFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ sysroot, "System/Library/Frameworks" }) });
    }
    root.addIncludePath(dep.path("third_party/sqlite"));
    root.addImport("geometry", geometry);
    root.addImport("json", json);
    root.addImport("canvas", canvas);
    root.addImport("terminal_vt", terminal_vt);
    root.addImport("assets", sdkModule(b, dep, target, optimize, "src/primitives/assets/root.zig"));
    root.addImport("app_dirs", sdkModule(b, dep, target, optimize, "src/primitives/app_dirs/root.zig"));
    root.addImport("trace", sdkModule(b, dep, target, optimize, "src/primitives/trace/root.zig"));
    root.addImport("app_manifest", sdkModule(b, dep, target, optimize, "src/primitives/app_manifest/root.zig"));
    root.addImport("diagnostics", sdkModule(b, dep, target, optimize, "src/primitives/diagnostics/root.zig"));
    root.addImport("platform_info", sdkModule(b, dep, target, optimize, "src/primitives/platform_info/root.zig"));

    // The macOS platform root's own tests lean on a tiny ImageIO helper
    // the framework compiles beside its desktop suite; the runtime files
    // pull that root in, so the artifact links it the same way.
    if (target.result.os.tag == .macos) {
        const sdk_include = if (b.sysroot) |sysroot| b.fmt("-I{s}/usr/include", .{sysroot}) else "";
        const flags: []const []const u8 = if (b.sysroot) |sysroot|
            &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-ObjC", "-mmacosx-version-min=11.0", "-isysroot", sysroot, sdk_include }
        else
            &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-ObjC", "-mmacosx-version-min=11.0" };
        root.addCSourceFile(.{ .file = dep.path("src/platform/macos/image_fit_test.m"), .flags = flags });
        root.linkFramework("Foundation", .{});
        root.linkFramework("ImageIO", .{});
        root.linkFramework("CoreGraphics", .{});
        root.linkSystemLibrary("objc", .{});
    }

    const tests = b.addTest(.{ .root_module = root });
    const step = b.step("test-terminal", "Run the framework's terminal-session store tests against the wired emulator");
    step.dependOn(&b.addRunArtifact(tests).step);
}

fn sdkModule(b: *std.Build, dep: *std.Build.Dependency, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode, path: []const u8) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = dep.path(path),
        .target = target,
        .optimize = optimize,
    });
}
