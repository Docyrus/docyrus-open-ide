import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("../node_modules/@native-sdk/cli/build.zig", import.meta.url);
const source = readFileSync(target, "utf8");
const marker = "// Docyrus: SDK test fixtures are absent from the npm package.";
const original = `    _ = gpu_dashboard_stage.add("gpu_dashboard_reference_access.zig", @embedFile("tests/ts-core/gpu-dashboard-reference/main.zig") ++
        "\\npub const migrationScene = shell_scene;\\npub const migrationOptions = dashboardOptions;\\n");`;
const replacement = `    ${marker}
    // Read at graph construction time, after the repository-only suite's
    // admission check, rather than embedding a missing file at compile time.
    const gpu_dashboard_reference = std.Io.Dir.cwd().readFileAlloc(
        b.graph.io,
        b.pathFromRoot("tests/ts-core/gpu-dashboard-reference/main.zig"),
        b.allocator,
        .limited(1024 * 1024),
    ) catch @panic("unable to read the SDK GPU dashboard test fixture");
    _ = gpu_dashboard_stage.add("gpu_dashboard_reference_access.zig", b.fmt(
        "{s}\\npub const migrationScene = shell_scene;\\npub const migrationOptions = dashboardOptions;\\n",
        .{gpu_dashboard_reference},
    ));`;

if (!source.includes(marker)) {
  if (!source.includes(original)) {
    throw new Error("The installed Native SDK build fixture changed; update the Docyrus build-fixtures patch before building.");
  }
  writeFileSync(target, source.replace(original, () => replacement));
}
