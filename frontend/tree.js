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
    await invoke("workspace.openPath", { projectId, path });
    status.textContent = path;
  } catch (error) {
    lastOpenedPath = "";
    status.textContent = error instanceof Error ? error.message : "Could not open file";
  }
}

async function renderTree() {
  status.textContent = "Loading project files…";
  try {
    const paths = await invoke("workspace.listTree", { projectId });
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
    status.textContent = `${paths.length} items`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not load the project";
  }
}

applyTheme();
if (requestedTheme === "system") systemDark.addEventListener("change", applyTheme);
void renderTree();
window.addEventListener("beforeunload", () => tree?.cleanUp(), { once: true });
