import { FileTree, themeToTreeStyles } from "@pierre/trees";

const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project") || 0);
const requestedTheme = params.get("theme") || "system";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

const mount = document.querySelector("#tree-mount");
const status = document.querySelector("#tree-status");
const dialogRoot = document.querySelector("#dialog-root");
const filesTab = document.querySelector("#tab-files");
const searchTab = document.querySelector("#tab-search");
const filesPanel = document.querySelector("#panel-files");
const searchPanel = document.querySelector("#panel-search");
const filesActions = document.querySelector("#files-actions");
const newFileButton = document.querySelector("#action-new-file");
const newFolderButton = document.querySelector("#action-new-folder");
const searchQueryInput = document.querySelector("#search-query");
const searchIncludeInput = document.querySelector("#search-include");
const searchExcludeInput = document.querySelector("#search-exclude");
const searchCaseButton = document.querySelector("#search-case");
const searchWordButton = document.querySelector("#search-word");
const searchFiltersToggle = document.querySelector("#search-filters-toggle");
const searchFilters = document.querySelector("#search-filters");
const searchSummary = document.querySelector("#search-summary");
const searchResults = document.querySelector("#search-results");

// The explorer auto-loads this many result pages before it asks the reader to
// continue, so a common word in a large project cannot walk the whole tree.
const searchAutoPageLimit = 12;
const searchDebounceMs = 220;

let tree;
let treeRootLabel = "project";
let treeEditable = false;
let lastOpenedPath = "";
// The explorer's own copy buffer, holding one project-relative path. Paths
// only mean anything inside their project, so it is stored per project and
// mirrored to sessionStorage to survive an explorer reload (refresh, theme).
let clipboardPath = null;
const clipboardKey = `docyrus:explorer-clipboard:${projectId}`;

// The last file a drag picked up, where the explorer's viewport sits on screen,
// and where the pointer was while the drag moved. The `drag` event only reaches
// the source while the pointer is over the explorer, so the release point comes
// from `dragend` when it carries one.
let draggedFilePath = "";
let dragOrigin = null;
let draggedPoint = null;

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

function messageFrom(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

let statusTicket = 0;

// Every write takes the next ticket. A caller that awaited across a write holds
// a stale ticket and stays quiet instead of overwriting the newer message.
function setStatus(text, tone) {
  status.textContent = text;
  status.title = text;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
  statusTicket += 1;
  return statusTicket;
}

function reportError(error, fallback) {
  setStatus(messageFrom(error, fallback), "error");
}

/* Path helpers ----------------------------------------------------------- */

function isDirectoryPath(path) {
  return path.endsWith("/");
}

function basenameOf(path) {
  const trimmed = isDirectoryPath(path) ? path.slice(0, -1) : path;
  const separator = trimmed.lastIndexOf("/");
  return separator < 0 ? trimmed : trimmed.slice(separator + 1);
}

function parentDirectoryOf(path) {
  const trimmed = isDirectoryPath(path) ? path.slice(0, -1) : path;
  const separator = trimmed.lastIndexOf("/");
  return separator < 0 ? "" : trimmed.slice(0, separator + 1);
}

function displayDirectory(directory) {
  return directory ? directory.slice(0, -1) : treeRootLabel;
}

// Both the tree model and the bridge reject a name that would escape the
// project or collide with the path separator conventions the tree relies on.
function invalidNameReason(name) {
  if (name.length === 0) return "Enter a name";
  if (name.startsWith("/")) return "A name cannot start with a separator";
  if (name.endsWith("/")) return "A name cannot end with a separator";
  if (name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "A name cannot contain an empty, . or .. segment";
  }
  return null;
}

// Selection only: the tree parks keyboard focus on its first row before anyone
// has touched it, and a new file belongs at the project root until then.
function currentTargetDirectory() {
  const selected = tree?.getSelectedPaths().at(-1);
  if (!selected) return "";
  return isDirectoryPath(selected) ? selected : parentDirectoryOf(selected);
}

function expandAncestors(path) {
  const trimmed = isDirectoryPath(path) ? path.slice(0, -1) : path;
  const segments = trimmed.split("/");
  let prefix = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    prefix += `${segments[index]}/`;
    const item = tree?.getItem(prefix);
    if (item?.isDirectory()) item.expand();
  }
}

function revealPath(path) {
  expandAncestors(path);
  tree?.scrollToPath(path, { focus: true });
}

function readStoredClipboard() {
  try {
    return window.sessionStorage.getItem(clipboardKey);
  } catch {
    return null;
  }
}

function setClipboardPath(path) {
  clipboardPath = path;
  try {
    if (path) window.sessionStorage.setItem(clipboardKey, path);
    else window.sessionStorage.removeItem(clipboardKey);
  } catch {
    // A blocked store still leaves the in-memory copy usable this session.
  }
}

// A copied path that has just been deleted or moved cannot be pasted, so drop
// it rather than leave Paste enabled on a promise the bridge will refuse.
function forgetClipboardUnder(path) {
  if (clipboardPath == null) return;
  const removed = isDirectoryPath(path) ? path.slice(0, -1) : path;
  const copied = isDirectoryPath(clipboardPath) ? clipboardPath.slice(0, -1) : clipboardPath;
  if (copied === removed || copied.startsWith(`${removed}/`)) setClipboardPath(null);
}

function requireEditableProject() {
  if (treeEditable) return true;
  setStatus("Open a project folder to change files", "error");
  return false;
}

/* Dialogs ---------------------------------------------------------------- */

function openDialog({ title, message, initialValue, confirmLabel, variant, withInput }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const dialog = document.createElement("form");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", title);

    const heading = document.createElement("div");
    heading.className = "dialog-title";
    heading.textContent = title;
    dialog.append(heading);

    if (message) {
      const description = document.createElement("div");
      description.className = "dialog-message";
      description.textContent = message;
      dialog.append(description);
    }

    let input = null;
    let error = null;
    if (withInput) {
      input = document.createElement("input");
      input.type = "text";
      input.value = initialValue ?? "";
      input.spellcheck = false;
      input.autocomplete = "off";
      input.setAttribute("aria-label", title);
      dialog.append(input);
      error = document.createElement("div");
      error.className = "dialog-message";
      dialog.append(error);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "dialog-button";
    cancel.textContent = "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.className = "dialog-button";
    confirm.dataset.variant = variant ?? "primary";
    confirm.textContent = confirmLabel ?? "OK";
    actions.append(cancel, confirm);
    dialog.append(actions);
    backdrop.append(dialog);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKeyDown, true);
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(withInput ? null : false);
    };

    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!withInput) {
        close(true);
        return;
      }
      const value = input.value.trim();
      const reason = invalidNameReason(value);
      if (reason) {
        error.textContent = reason;
        input.focus();
        return;
      }
      close(value);
    });
    cancel.addEventListener("click", () => close(withInput ? null : false));
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close(withInput ? null : false);
    });
    document.addEventListener("keydown", onKeyDown, true);

    dialogRoot.append(backdrop);
    if (input) {
      input.focus();
      const extension = input.value.lastIndexOf(".");
      if (extension > 0) input.setSelectionRange(0, extension);
      else input.select();
    } else confirm.focus();
  });
}

/* Explorer actions ------------------------------------------------------- */

async function openPath(path, options = {}) {
  if (!path || isDirectoryPath(path)) return;
  if (!options.force && path === lastOpenedPath) return;
  lastOpenedPath = path;
  const ticket = setStatus(`Opening ${path}`);
  try {
    await invoke("workspace.openPath", { path, edit: options.edit === true, line: options.line ?? 0 });
    if (ticket === statusTicket) setStatus(path);
  } catch (error) {
    lastOpenedPath = "";
    if (ticket === statusTicket) reportError(error, "Could not open file");
  }
}

async function createEntry(directory, parentDirectory) {
  if (!requireEditableProject()) return;
  const parent = parentDirectory ?? currentTargetDirectory();
  const name = await openDialog({
    title: directory ? "New Folder" : "New File",
    message: `Creating in ${displayDirectory(parent)}`,
    confirmLabel: "Create",
    withInput: true,
  });
  if (!name) return;
  const path = `${parent}${name}`;
  try {
    const created = await invoke("workspace.createEntry", { path, directory });
    const canonical = directory ? `${created}/` : created;
    tree?.add(canonical);
    revealPath(canonical);
    if (!directory) await openPath(created, { force: true });
    setStatus(`Created ${created}`);
  } catch (error) {
    reportError(error, `Could not create ${path}`);
  }
}

function beginRename(path) {
  if (!requireEditableProject()) return;
  if (!tree?.startRenaming(path)) setStatus("This item cannot be renamed", "error");
}

async function applyRename(event) {
  const source = event.isFolder ? `${event.sourcePath}/` : event.sourcePath;
  const destination = event.isFolder ? `${event.destinationPath}/` : event.destinationPath;
  try {
    await invoke("workspace.movePath", { from: event.sourcePath, to: event.destinationPath });
    forgetClipboardUnder(source);
    setStatus(`Renamed to ${event.destinationPath}`);
  } catch (error) {
    // The tree renames its own model before this runs, so a rejected rename has
    // to be put back or the explorer would show a file that does not exist.
    try {
      tree?.move(destination, source);
    } catch {}
    reportError(error, `Could not rename ${basenameOf(source)}`);
  }
}

async function applyDrop(event) {
  // The explorer accepted this drag itself, so the release is a move inside the
  // project and never a hand-off to the workspace.
  draggedFilePath = "";
  const directory = event.target.kind === "root" || event.target.directoryPath == null ? "" : event.target.directoryPath;
  const moves = [];
  for (const source of event.draggedPaths) {
    const destination = `${directory}${basenameOf(source)}${isDirectoryPath(source) ? "/" : ""}`;
    if (destination !== source) moves.push({ source, destination });
  }
  if (moves.length === 0) return;
  for (const move of moves) {
    try {
      await invoke("workspace.movePath", { from: move.source, to: move.destination });
      forgetClipboardUnder(move.source);
    } catch (error) {
      try {
        tree?.move(move.destination, move.source);
      } catch {}
      reportError(error, `Could not move ${basenameOf(move.source)}`);
      return;
    }
  }
  setStatus(
    moves.length === 1
      ? `Moved ${basenameOf(moves[0].source)} to ${displayDirectory(directory)}`
      : `Moved ${moves.length} items to ${displayDirectory(directory)}`,
  );
}

async function copyIntoFolder(path, destination, describe) {
  if (!requireEditableProject()) return;
  try {
    const created = await invoke("workspace.copyEntry", { path, destination });
    if (isDirectoryPath(path)) {
      // A copied folder brings descendants the tree model has never seen.
      await renderTree();
    } else {
      tree?.add(created);
      revealPath(created);
    }
    setStatus(`${describe} ${created}`);
  } catch (error) {
    reportError(error, `Could not copy ${basenameOf(path)}`);
  }
}

function duplicateEntry(path) {
  return copyIntoFolder(path, parentDirectoryOf(path), "Duplicated to");
}

function copyEntry(path) {
  if (!requireEditableProject()) return;
  setClipboardPath(path);
  setStatus(`Copied ${basenameOf(path)}`);
}

async function pasteEntry(targetPath) {
  if (!requireEditableProject()) return;
  const source = clipboardPath;
  if (!source) {
    setStatus("Nothing to paste", "error");
    return;
  }
  const destination = isDirectoryPath(targetPath) ? targetPath : parentDirectoryOf(targetPath);
  await copyIntoFolder(source, destination, "Pasted to");
}

async function copyPathToClipboard(path, absolute) {
  try {
    const copied = await invoke("workspace.copyPath", { path, absolute });
    setStatus(`Copied ${copied}`);
  } catch (error) {
    reportError(error, "Could not copy the path");
  }
}

async function deleteEntry(path) {
  if (!requireEditableProject()) return;
  const name = basenameOf(path);
  const confirmed = await openDialog({
    title: `Delete ${name}?`,
    message: isDirectoryPath(path)
      ? "This folder and everything inside it is deleted from disk."
      : "This file is deleted from disk.",
    confirmLabel: "Delete",
    variant: "destructive",
  });
  if (!confirmed) return;
  try {
    await invoke("workspace.deletePath", { path });
    tree?.remove(path, isDirectoryPath(path) ? { recursive: true } : undefined);
    forgetClipboardUnder(path);
    setStatus(`Deleted ${name}`);
  } catch (error) {
    reportError(error, `Could not delete ${name}`);
  }
}

/* Context menu ----------------------------------------------------------- */

function contextMenuEntries(item) {
  const path = item.path;
  const transfer = [
    { label: "Duplicate", run: () => duplicateEntry(path) },
    { label: "Copy", run: () => copyEntry(path) },
    // Nothing copied yet means nothing to paste, so the item stays inert
    // rather than disappearing and shifting the menu under the pointer.
    { label: "Paste", disabled: clipboardPath == null, run: () => pasteEntry(path) },
    { separator: true },
    { label: "Copy Path", run: () => copyPathToClipboard(path, true) },
    { label: "Copy Relative Path", run: () => copyPathToClipboard(path, false) },
    { separator: true },
    { label: "Delete", destructive: true, handoff: true, run: () => deleteEntry(path) },
  ];
  if (item.kind === "directory") {
    return [
      { label: "Rename", handoff: true, run: () => beginRename(path) },
      { label: "Create file", handoff: true, run: () => createEntry(false, path) },
      { label: "Create subfolder", handoff: true, run: () => createEntry(true, path) },
      { separator: true },
      ...transfer,
    ];
  }
  return [
    { label: "Edit", run: () => openPath(path, { edit: true, force: true }) },
    { label: "Rename", handoff: true, run: () => beginRename(path) },
    { separator: true },
    ...transfer,
  ];
}

function renderContextMenu(item, context) {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  const buttons = [];
  for (const entry of contextMenuEntries(item)) {
    if (entry.separator) {
      const separator = document.createElement("div");
      separator.className = "context-menu-separator";
      separator.setAttribute("role", "separator");
      menu.append(separator);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = entry.label;
    if (entry.destructive) button.dataset.destructive = "true";
    if (entry.disabled) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      menu.append(button);
      continue;
    }
    button.addEventListener("click", () => {
      // A rename input or dialog takes focus next; letting the menu restore
      // focus to the row first would steal it straight back.
      context.close({ restoreFocus: !entry.handoff });
      void entry.run();
    });
    buttons.push(button);
    menu.append(button);
  }

  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      context.close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });

  queueMicrotask(() => {
    const margin = 4;
    const rect = menu.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
    if (rect.left + dx < margin) dx = margin - rect.left;
    if (rect.bottom > window.innerHeight - margin) dy = window.innerHeight - margin - rect.bottom;
    if (rect.top + dy < margin) dy = margin - rect.top;
    if (dx !== 0 || dy !== 0) menu.style.transform = `translate(${dx}px, ${dy}px)`;
    buttons[0]?.focus();
  });
  return menu;
}

/* File tree -------------------------------------------------------------- */

async function loadTreePaths() {
  const paths = [];
  let root = "";
  let editable = false;
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
    if (offset === 0) {
      root = pageRoot;
      editable = Boolean(result?.editable);
    }
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

  return { paths, root, editable, skipped, truncated };
}

async function renderTree() {
  setStatus("Loading project files…");
  try {
    const { paths, root, editable, skipped, truncated } = await loadTreePaths();
    treeEditable = editable;
    treeRootLabel = basenameOf(root) || root || "project";
    updateFileActionAvailability();

    tree?.cleanUp();
    mount.textContent = "";
    tree = new FileTree({
      id: `workspace-files-${projectId}`,
      paths,
      flattenEmptyDirectories: false,
      initialExpansion: "closed",
      search: true,
      density: "compact",
      dragAndDrop: editable && {
        canDrop: ({ target }) => target.kind === "root" || target.directoryPath != null,
        onDropComplete(event) {
          void applyDrop(event);
        },
        onDropError(message) {
          setStatus(message, "error");
        },
      },
      renaming: editable && {
        onRename(event) {
          void applyRename(event);
        },
        onError(message) {
          setStatus(message, "error");
        },
      },
      composition: editable
        ? { contextMenu: { enabled: true, triggerMode: "both", render: renderContextMenu } }
        : undefined,
    });
    tree.render({ containerWrapper: mount });
    applyTheme();

    // A reload (refresh, theme change) rebuilds the tree, so re-adopt the
    // copied path only while it still exists in the project.
    const stored = readStoredClipboard();
    setClipboardPath(stored && tree.getItem(stored) ? stored : null);

    const notes = [];
    if (truncated) notes.push("showing first 1,200");
    if (skipped > 0) notes.push(`${skipped} inaccessible skipped`);
    setStatus(
      paths.length === 0
        ? `No files in ${root}`
        : `${paths.length} items in ${root}${notes.length ? ` • ${notes.join(" • ")}` : ""}`,
    );
  } catch (error) {
    reportError(error, "Could not list the active project");
  }
}

function updateFileActionAvailability() {
  newFileButton.disabled = !treeEditable;
  newFolderButton.disabled = !treeEditable;
  const reason = treeEditable ? null : "Only a project folder can add files";
  newFileButton.title = reason ?? "New File";
  newFolderButton.title = reason ?? "New Folder";
  searchQueryInput.disabled = !treeEditable;
}

/* Row gestures ----------------------------------------------------------- */

// The tree selects the row a drag starts on, so a selection listener would have
// opened the file the moment the pointer moved. Opening is driven from the
// click instead: a click only lands when the pointer is pressed and released on
// the same row, which is exactly the gesture that should open a file.
function rowFromEvent(event) {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (node === mount) return null;
    // A row is itself a button, so its own path settles the walk first.
    const path = node.getAttribute("data-item-path");
    if (path != null) return { path, isFile: node.getAttribute("data-item-type") === "file" };
    // Anything else that takes input -- the rename field, a row action --
    // owns the gesture it received.
    if (node.matches("input, textarea, button")) return null;
  }
  return null;
}

function dragPointFrom(event) {
  if (event.screenX === 0 && event.screenY === 0) return null;
  const origin = dragOrigin ?? { x: window.screenX, y: window.screenY };
  return { x: event.screenX - origin.x, y: event.screenY - origin.y };
}

function beginRowDrag(event) {
  const row = rowFromEvent(event);
  draggedFilePath = row?.isFile ? row.path : "";
  // The drag starts inside the explorer, where the same point is known in both
  // frames. That fixes the viewport's screen origin without having to trust
  // what `window.screenX` means for a WebView inside a native window.
  dragOrigin = event.screenX === 0 && event.screenY === 0
    ? null
    : { x: event.screenX - event.clientX, y: event.screenY - event.clientY };
  draggedPoint = null;
}

function trackRowDrag(event) {
  if (!draggedFilePath) return;
  draggedPoint = dragPointFrom(event) ?? draggedPoint;
}

// A drop the explorer itself accepted has already moved the file, and one that
// landed back inside the explorer was simply abandoned. Anything else was
// released over the native workspace, which decides what the pane under that
// point does with the file.
async function endRowDrag(event) {
  const path = draggedFilePath;
  const point = dragPointFrom(event) ?? draggedPoint;
  draggedFilePath = "";
  dragOrigin = null;
  draggedPoint = null;
  if (!path || point == null) return;
  if (event.dataTransfer && event.dataTransfer.dropEffect !== "none") return;
  if (point.x >= 0 && point.y >= 0 && point.x <= window.innerWidth && point.y <= window.innerHeight) return;
  try {
    await invoke("workspace.dropPath", {
      path,
      x: point.x,
      y: point.y,
      viewWidth: window.innerWidth,
      viewHeight: window.innerHeight,
    });
    lastOpenedPath = path;
    setStatus(path);
  } catch (error) {
    reportError(error, `Could not open ${basenameOf(path)}`);
  }
}

/* Panels ----------------------------------------------------------------- */

function activatePanel(name) {
  filesTab.setAttribute("aria-selected", String(name === "files"));
  searchTab.setAttribute("aria-selected", String(name === "search"));
  filesPanel.hidden = name !== "files";
  searchPanel.hidden = name !== "search";
  filesActions.hidden = name !== "files";
  if (name === "search") {
    if (!treeEditable) setStatus("Search needs an open project folder", "error");
    else searchQueryInput.focus();
  }
}

/* Search ----------------------------------------------------------------- */

const searchOptions = { matchCase: false, wholeWord: false };
let searchToken = 0;
let searchGroups = new Map();
let searchMatchCount = 0;
let searchCursor = { fileOffset: 0, matchOffset: 0 };
let searchComplete = true;
let searchRunning = false;
let searchDebounce = 0;
const collapsedSearchGroups = new Set();

function searchRequest() {
  return {
    query: searchQueryInput.value,
    matchCase: searchOptions.matchCase,
    wholeWord: searchOptions.wholeWord,
    include: searchIncludeInput.value.trim(),
    exclude: searchExcludeInput.value.trim(),
    fileOffset: searchCursor.fileOffset,
    matchOffset: searchCursor.matchOffset,
  };
}

function createChevron() {
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "chevron");
  chevron.setAttribute("viewBox", "0 0 16 16");
  chevron.setAttribute("width", "10");
  chevron.setAttribute("height", "10");
  chevron.setAttribute("aria-hidden", "true");
  const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
  stroke.setAttribute("d", "M3.5 6 8 10.5 12.5 6");
  stroke.setAttribute("fill", "none");
  stroke.setAttribute("stroke", "currentColor");
  stroke.setAttribute("stroke-width", "1.6");
  stroke.setAttribute("stroke-linecap", "round");
  stroke.setAttribute("stroke-linejoin", "round");
  chevron.append(stroke);
  return chevron;
}

function summarizeSearch(extra) {
  if (searchMatchCount === 0) return extra ?? "";
  const matches = `${searchMatchCount} result${searchMatchCount === 1 ? "" : "s"}`;
  const files = `${searchGroups.size} file${searchGroups.size === 1 ? "" : "s"}`;
  return `${matches} in ${files}${extra ? ` • ${extra}` : ""}`;
}

function renderSearchResults() {
  searchResults.textContent = "";
  for (const [path, matches] of searchGroups) {
    const group = document.createElement("div");
    group.className = "search-group";

    const collapsed = collapsedSearchGroups.has(path);
    const header = document.createElement("button");
    header.type = "button";
    header.className = "search-group-header";
    header.setAttribute("aria-expanded", String(!collapsed));

    const chevron = createChevron();
    const name = document.createElement("span");
    name.className = "search-group-name";
    name.textContent = basenameOf(path);
    const directory = document.createElement("span");
    directory.className = "search-group-directory";
    const parent = parentDirectoryOf(path);
    directory.textContent = parent ? parent.slice(0, -1) : "";
    const count = document.createElement("span");
    count.className = "search-group-count";
    count.textContent = String(matches.length);
    header.append(chevron, name, directory, count);
    header.addEventListener("click", () => {
      if (collapsedSearchGroups.has(path)) collapsedSearchGroups.delete(path);
      else collapsedSearchGroups.add(path);
      renderSearchResults();
    });
    group.append(header);

    if (!collapsed) {
      for (const match of matches) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "search-match";
        const line = document.createElement("span");
        line.className = "search-match-line";
        line.textContent = String(match.line);
        const text = document.createElement("span");
        text.className = "search-match-text";
        const before = document.createElement("span");
        before.textContent = match.before ?? "";
        const hit = document.createElement("mark");
        hit.textContent = match.match ?? "";
        const after = document.createElement("span");
        after.textContent = match.after ?? "";
        text.append(before, hit, after);
        row.append(line, text);
        row.title = `${path}:${match.line}`;
        row.addEventListener("click", () => {
          for (const current of searchResults.querySelectorAll(".search-match[aria-current]")) {
            current.removeAttribute("aria-current");
          }
          row.setAttribute("aria-current", "true");
          void openPath(path, { line: match.line, force: true });
        });
        group.append(row);
      }
    }
    searchResults.append(group);
  }

  if (!searchComplete && !searchRunning && searchMatchCount > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "search-more";
    more.textContent = "Load more results";
    more.addEventListener("click", () => void continueSearch());
    searchResults.append(more);
  }
}

function resetSearch() {
  searchGroups = new Map();
  searchMatchCount = 0;
  searchCursor = { fileOffset: 0, matchOffset: 0 };
  searchComplete = true;
  collapsedSearchGroups.clear();
  renderSearchResults();
}

async function continueSearch(reset = false) {
  if (!reset && searchRunning) return;
  const query = searchQueryInput.value;
  if (reset) resetSearch();
  if (!query) {
    searchSummary.textContent = "";
    return;
  }
  if (!treeEditable) {
    searchSummary.textContent = "Search needs an open project folder";
    return;
  }

  const token = ++searchToken;
  searchRunning = true;
  searchSummary.textContent = summarizeSearch("searching…") || "Searching…";
  try {
    let pages = 0;
    while (pages < searchAutoPageLimit) {
      const page = await invoke("workspace.searchFiles", searchRequest());
      if (token !== searchToken) return;
      for (const match of page.matches ?? []) {
        const existing = searchGroups.get(match.path);
        if (existing) existing.push(match);
        else searchGroups.set(match.path, [match]);
        searchMatchCount += 1;
      }
      searchCursor = { fileOffset: page.nextFileOffset ?? 0, matchOffset: page.nextMatchOffset ?? 0 };
      searchComplete = Boolean(page.done);
      pages += 1;
      if (searchComplete) break;
    }
    searchRunning = false;
    renderSearchResults();
    searchSummary.textContent =
      searchMatchCount === 0
        ? "No results found"
        : summarizeSearch(searchComplete ? null : "more available");
  } catch (error) {
    if (token !== searchToken) return;
    searchRunning = false;
    searchSummary.textContent = messageFrom(error, "Search failed");
  }
}

function scheduleSearch() {
  window.clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(() => void continueSearch(true), searchDebounceMs);
}

function toggleSearchOption(button, key) {
  searchOptions[key] = !searchOptions[key];
  button.setAttribute("aria-pressed", String(searchOptions[key]));
  void continueSearch(true);
}

/* Wiring ----------------------------------------------------------------- */

mount.addEventListener("click", (event) => {
  const row = rowFromEvent(event);
  if (row?.isFile) void openPath(row.path);
});
mount.addEventListener("dragstart", beginRowDrag);
mount.addEventListener("drag", trackRowDrag);
mount.addEventListener("dragend", (event) => void endRowDrag(event));
filesTab.addEventListener("click", () => activatePanel("files"));
searchTab.addEventListener("click", () => activatePanel("search"));
newFileButton.addEventListener("click", () => void createEntry(false));
newFolderButton.addEventListener("click", () => void createEntry(true));
searchCaseButton.addEventListener("click", () => toggleSearchOption(searchCaseButton, "matchCase"));
searchWordButton.addEventListener("click", () => toggleSearchOption(searchWordButton, "wholeWord"));
searchFiltersToggle.addEventListener("click", () => {
  const expanded = searchFiltersToggle.getAttribute("aria-expanded") === "true";
  searchFiltersToggle.setAttribute("aria-expanded", String(!expanded));
  searchFilters.hidden = expanded;
});
searchQueryInput.addEventListener("input", scheduleSearch);
searchIncludeInput.addEventListener("input", scheduleSearch);
searchExcludeInput.addEventListener("input", scheduleSearch);
for (const input of [searchQueryInput, searchIncludeInput, searchExcludeInput]) {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    window.clearTimeout(searchDebounce);
    void continueSearch(true);
  });
}

applyTheme();
if (requestedTheme === "system") systemDark.addEventListener("change", applyTheme);
updateFileActionAvailability();
activatePanel("files");
void renderTree();
window.addEventListener("beforeunload", () => tree?.cleanUp(), { once: true });
