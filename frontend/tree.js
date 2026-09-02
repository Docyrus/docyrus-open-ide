import { FileTree } from "@pierre/trees";

const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project") || 0);
const requestedTheme = params.get("theme") || "system";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const mount = document.querySelector("#tree-mount");
const status = document.querySelector("#tree-status");
let tree;
let lastOpenedPath = "";

function applyTheme() {
  const theme = requestedTheme === "system" ? (systemDark.matches ? "dark" : "light") : requestedTheme;
  document.documentElement.dataset.theme = theme;
}

async function invoke(command, payload) {
  if (!window.zero?.invoke) throw new Error("Native bridge is unavailable");
  return window.zero.invoke(command, payload);
}

async function openPath(path) {
  if (!path || path.endsWith("/") || path === lastOpenedPath) return;
  lastOpenedPath = path;
  status.textContent = `Opening ${path}`;
  try {
    await invoke("workspace.openPath", { path });
    status.textContent = path;
  } catch (error) {
    lastOpenedPath = "";
    status.textContent = error instanceof Error ? error.message : "Could not open file";
  }
}

async function renderTree() {
  status.textContent = "Loading project files…";
  try {
    const result = await invoke("workspace.listTree", {});
    const paths = Array.isArray(result) ? result : result?.paths;
    const root = Array.isArray(result) ? "" : result?.root;
    const skipped = Array.isArray(result) ? 0 : Number(result?.skipped || 0);
    const truncated = Array.isArray(result) ? false : Boolean(result?.truncated);
    if (!Array.isArray(paths) || typeof root !== "string") {
      throw new Error("The active project returned an invalid file list");
    }
    tree = new FileTree({
      id: `workspace-files-${projectId}`,
      paths: Array.isArray(paths) ? paths : [],
      flattenEmptyDirectories: false,
      initialExpansion: "open",
      search: true,
      density: "compact",
      onSelectionChange(selectedPaths) {
        const path = selectedPaths.at(-1);
        if (path) void openPath(path);
      },
    });
    tree.render({ containerWrapper: mount });
    const notes = [];
    if (truncated) notes.push("showing first 1,200");
    if (skipped > 0) notes.push(`${skipped} inaccessible skipped`);
    status.textContent = paths.length === 0
      ? `No files in ${root}`
      : `${paths.length} items in ${root}${notes.length ? ` • ${notes.join(" • ")}` : ""}`;
    status.title = status.textContent;
  } catch (error) {
    status.textContent = error instanceof Error
      ? `Could not list the active project: ${error.message}`
      : "Could not list the active project";
    status.title = status.textContent;
  }
}

applyTheme();
if (requestedTheme === "system") systemDark.addEventListener("change", applyTheme);
void renderTree();
window.addEventListener("beforeunload", () => tree?.cleanUp(), { once: true });
