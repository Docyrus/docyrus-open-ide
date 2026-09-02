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
    const editor = monaco.editor.create(document.querySelector("#editor"), {
      value: file.content,
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

    let saveTimer;
    let savedVersion = editor.getModel().getAlternativeVersionId();
    const save = async () => {
      window.clearTimeout(saveTimer);
      const version = editor.getModel().getAlternativeVersionId();
      if (version === savedVersion) return;
      status.textContent = "Saving…";
      try {
        await invoke("workspace.writeFile", { projectId, slot, content: editor.getValue() });
        savedVersion = version;
        status.textContent = "Saved";
        window.setTimeout(() => {
          if (status.textContent === "Saved") status.textContent = "";
        }, 900);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Save failed";
      }
    };
    editor.onDidChangeModelContent(() => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, 500);
    });
    editor.addAction({
      id: "docyrus.save",
      label: "Save",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: save,
    });
  } catch (error) {
    loading.textContent = error instanceof Error ? error.message : "Could not open this file";
  }
});
