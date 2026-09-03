import { FileTree, themeToTreeStyles } from "@pierre/trees";

const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project") || 0);
const requestedTheme = params.get("theme") || "system";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const mount = document.querySelector("#tree-mount");
const status = document.querySelector("#tree-status");
let tree;
let lastOpenedPath = "";

const themes = {
  light: {
    type: "light",
    colors: {
      "sideBar.background": "#f7f7f8",
      "sideBar.foreground": "#202124",
      "sideBarSectionHeader.foreground": "#6d6f73",
      "sideBar.border": "rgba(0, 0, 0, 0.1)",
      "list.hoverBackground": "rgba(0, 122, 255, 0.08)",
      "list.activeSelectionBackground": "rgba(0, 122, 255, 0.14)",
      "list.activeSelectionForeground": "#202124",
      "list.focusOutline": "#007aff",
      "input.background": "#ffffff",
      "input.border": "rgba(0, 0, 0, 0.16)",
      "scrollbarSlider.background": "rgba(0, 0, 0, 0.22)",
    },
  },
  dark: {
    type: "dark",
    colors: {
      "sideBar.background": "#18191b",
      "sideBar.foreground": "#f1f1f2",
      "sideBarSectionHeader.foreground": "#a8aaae",
      "sideBar.border": "rgba(255, 255, 255, 0.11)",
      "list.hoverBackground": "rgba(255, 255, 255, 0.08)",
      "list.activeSelectionBackground": "rgba(10, 132, 255, 0.28)",
      "list.activeSelectionForeground": "#ffffff",
      "list.focusOutline": "#0a84ff",
      "input.background": "#111214",
      "input.border": "rgba(255, 255, 255, 0.16)",
      "scrollbarSlider.background": "rgba(255, 255, 255, 0.24)",
    },
  },
};

function resolvedThemeName() {
  return requestedTheme === "system" ? (systemDark.matches ? "dark" : "light") : requestedTheme;
}

function setElementStyles(element, styles) {
  if (!element) return;
  for (const [property, value] of Object.entries(styles)) {
    if (property.startsWith("--")) element.style.setProperty(property, value);
    else element.style[property] = value;
  }
}

function applyTheme() {
  const themeName = resolvedThemeName();
  document.documentElement.dataset.theme = themeName;
  setElementStyles(tree?.getFileTreeContainer(), themeToTreeStyles(themes[themeName]));
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
    const paths = [];
    let root = "";
    let offset = 0;
    let skipped = 0;
    let truncated = false;

    while (true) {
      const result = await invoke("workspace.listTree", { offset });
      const pagePaths = Array.isArray(result) ? result : result?.paths;
      const pageRoot = Array.isArray(result) ? "" : result?.root;
      if (!Array.isArray(pagePaths) || typeof pageRoot !== "string") {
        throw new Error("The active project returned an invalid file list");
      }
      if (offset === 0) root = pageRoot;
      paths.push(...pagePaths);
      skipped = Math.max(skipped, Number(result?.skipped || 0));
      truncated ||= Boolean(result?.truncated);

      if (Array.isArray(result) || result?.done) break;
      const nextOffset = Number(result?.nextOffset);
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
        throw new Error("The active project returned an invalid file-list cursor");
      }
      offset = nextOffset;
    }

    mount.textContent = "";
    tree = new FileTree({
      id: `workspace-files-${projectId}`,
      paths: Array.isArray(paths) ? paths : [],
      flattenEmptyDirectories: false,
      initialExpansion: "closed",
      search: true,
      density: "compact",
      onSelectionChange(selectedPaths) {
        const path = selectedPaths.at(-1);
        if (path) void openPath(path);
      },
    });
    tree.render({ containerWrapper: mount });
    applyTheme();
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
