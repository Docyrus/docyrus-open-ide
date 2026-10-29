import { accessSync, cpSync, rmSync } from "node:fs";

const source = new URL("../node_modules/monaco-editor/min/vs/", import.meta.url);
const target = new URL("../frontend/dist/vs/", import.meta.url);

// Monaco's AMD build includes versioned chunks and workers. Replace the whole
// directory so an upgrade cannot leave assets from the previous release.
accessSync(source);
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
