import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL(
    "../node_modules/@native-sdk/cli/src/runtime/ui_app.zig",
    import.meta.url,
  ),
);

const source = readFileSync(target, "utf8");
const marker = "// Docyrus hosts four editor WebViews plus the File Explorer.";

if (!source.includes(marker)) {
  const original = `/// Maximum number of webview panes a \`UiApp\` can drive (\`Options.web_panes\`).
pub const max_web_panes: usize = 4;`;
  const replacement = `/// Maximum number of webview panes a \`UiApp\` can drive (\`Options.web_panes\`).
// Docyrus hosts four editor WebViews plus the File Explorer.
pub const max_web_panes: usize = 5;`;

  if (!source.includes(original)) {
    throw new Error(
      "The installed Native SDK WebView pane limit changed; update the Docyrus pane-limit patch before building.",
    );
  }

  writeFileSync(target, source.replace(original, replacement));
}
