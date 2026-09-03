const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project") || 0);
const slot = Number(params.get("slot") || 0);
const requestedTheme = params.get("theme") || "system";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

const languageByExtension = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  py: "python",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

function resolvedTheme() {
  return requestedTheme === "system" ? (systemDark.matches ? "dark" : "light") : requestedTheme;
}

function applyDocumentTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}

function languageFor(path) {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  return languageByExtension[extension] || "plaintext";
}

async function invoke(command, payload) {
  if (!window.zero?.invoke) throw new Error("Native bridge is unavailable");
  return window.zero.invoke(command, payload);
}

self.MonacoEnvironment = {
  getWorkerUrl() {
    return "./vs/base/worker/workerMain.js";
  },
};

applyDocumentTheme();
if (requestedTheme === "system") systemDark.addEventListener("change", () => {
  applyDocumentTheme();
  if (window.monaco) monaco.editor.setTheme(systemDark.matches ? "vs-dark" : "vs");
});

require.config({ paths: { vs: "./vs" } });
require(["vs/editor/editor.main"], async () => {
  const loading = document.querySelector("#loading");
  const status = document.querySelector("#save-status");
  try {
    if (!projectId || !slot) throw new Error("No file selected");
    const file = await invoke("workspace.readFile", { projectId, slot });
    const draftKey = `docyrus:unsaved:${file.path}`;
    let draft = null;
    try {
      draft = window.localStorage.getItem(draftKey);
    } catch {}
    let savedContent = file.content;
    const editor = monaco.editor.create(document.querySelector("#editor"), {
      value: draft ?? file.content,
      language: languageFor(file.relativePath),
      theme: resolvedTheme() === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 21,
      fontLigatures: true,
      minimap: { enabled: false },
      padding: { top: 14 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: "gutter",
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      stickyScroll: { enabled: true },
      tabSize: 2,
    });
    document.title = file.relativePath;
    loading.remove();
    editor.focus();

    let lastReportedDirty = null;
    let actionInFlight = false;

    function persistDraft(content, dirty) {
      try {
        if (dirty) window.localStorage.setItem(draftKey, content);
        else window.localStorage.removeItem(draftKey);
      } catch {
        status.textContent = "Could not store the unsaved draft";
      }
    }

    async function reportDirty(dirty) {
      if (dirty === lastReportedDirty) return;
      lastReportedDirty = dirty;
      try {
        await invoke("workspace.editorDirty", { projectId, slot, dirty });
      } catch {
        lastReportedDirty = null;
      }
    }

    function syncDirtyState() {
      const content = editor.getValue();
      const dirty = content !== savedContent;
      persistDraft(content, dirty);
      status.textContent = dirty ? "Unsaved" : "";
      void reportDirty(dirty);
      return dirty;
    }

    const save = async (closeAfterSave = false, force = false) => {
      const content = editor.getValue();
      if (!force && content === savedContent) return true;
      status.textContent = "Saving…";
      try {
        await invoke("workspace.writeFile", { projectId, slot, content, closeAfterSave });
        savedContent = content;
        const stillDirty = editor.getValue() !== savedContent;
        persistDraft(editor.getValue(), stillDirty);
        await reportDirty(stillDirty);
        status.textContent = "Saved";
        window.setTimeout(() => {
          if (status.textContent === "Saved") status.textContent = "";
        }, 900);
        return true;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Save failed";
        return false;
      }
    };
    editor.onDidChangeModelContent(syncDirtyState);
    editor.addAction({
      id: "docyrus.save",
      label: "Save",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save(),
    });

    syncDirtyState();
    const actionTimer = window.setInterval(async () => {
      if (actionInFlight) return;
      try {
        const action = await invoke("workspace.editorAction", { projectId, slot });
        if (action === "none") return;
        actionInFlight = true;
        if (action === "saveAndClose") {
          if (!await save(true, true)) await invoke("workspace.editorActionFailed", { projectId, slot });
        } else if (action === "discardAndClose") {
          persistDraft("", false);
          await invoke("workspace.discardAndClose", { projectId, slot });
        }
      } catch {
        try {
          await invoke("workspace.editorActionFailed", { projectId, slot });
        } catch {}
      } finally {
        actionInFlight = false;
      }
    }, 250);
    window.addEventListener("beforeunload", () => {
      window.clearInterval(actionTimer);
      syncDirtyState();
    }, { once: true });
  } catch (error) {
    loading.textContent = error instanceof Error ? error.message : "Could not open this file";
  }
});
