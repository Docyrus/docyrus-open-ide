import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { FileTree } from "@pierre/trees";
import { observeRemoteFolders } from "../frontend/remote-folders.mjs";

function fixture(loadDirectory) {
  const paths = ["folder/", "unopened/"];
  const tree = new FileTree({ paths, initialExpansion: "closed", flattenEmptyDirectories: false });
  const requested = [];
  const errors = [];
  const dispose = observeRemoteFolders(tree, paths, {
    isCurrent: () => true,
    loadDirectory: async path => { requested.push(path); return { paths: await loadDirectory(path) }; },
    onLoading() {},
    onLoaded() {},
    onError: (_path, error) => errors.push(error),
  });
  return { tree, requested, errors, cleanUp() { dispose(); tree.cleanUp(); } };
}

test("expansion fetches one directory and reopening does not rescan expanded descendants", async () => {
  const f = fixture(path => path === "folder/" ? ["folder/deeper/", "folder/a.txt"] : ["folder/deeper/leaf.txt"]);
  try {
    assert.deepEqual(f.requested, []);
    f.tree.getItem("folder/").expand();
    await setImmediate();
    assert.deepEqual(f.requested, ["folder/"]);
    assert.equal(f.tree.getItem("folder/deeper/").isExpanded(), false);
    assert.equal(f.tree.getItem("folder/deeper/leaf.txt"), null);
    f.tree.getItem("folder/deeper/").expand();
    await setImmediate();
    assert.deepEqual(f.requested, ["folder/", "folder/deeper/"]);
    assert.ok(f.tree.getItem("folder/deeper/leaf.txt"));
    f.tree.getItem("folder/").collapse();
    f.tree.getItem("folder/").expand();
    await setImmediate();
    assert.deepEqual(f.requested, ["folder/", "folder/deeper/", "folder/"]);
    assert.deepEqual(f.errors, []);
  } finally { f.cleanUp(); }
});

test("refresh after deleting a row does not remove the missing row twice", async () => {
  let paths = ["folder/deeper/", "folder/a.txt"];
  const f = fixture(() => paths);
  try {
    f.tree.getItem("folder/").expand();
    await setImmediate();
    f.tree.remove("folder/a.txt");
    paths = ["folder/deeper/"];
    f.tree.getItem("folder/").collapse();
    f.tree.getItem("folder/").expand();
    await setImmediate();
    assert.deepEqual(f.requested, ["folder/", "folder/"]);
    assert.deepEqual(f.errors, []);
    assert.equal(f.tree.getItem("folder/a.txt"), null);
    assert.ok(f.tree.getItem("folder/deeper/"));
  } finally { f.cleanUp(); }
});

test("empty folders and failed loads can be reopened and retried", async () => {
  let reject = true;
  const f = fixture(() => { if (reject) throw new Error("denied"); return []; });
  try {
    f.tree.getItem("folder/").expand();
    await setImmediate();
    assert.equal(f.errors.length, 1);
    reject = false;
    f.tree.getItem("folder/").collapse();
    f.tree.getItem("folder/").expand();
    await setImmediate();
    assert.deepEqual(f.requested, ["folder/", "folder/"]);
    assert.equal(f.errors.length, 1);
    assert.ok(f.tree.getItem("folder/").isExpanded());
  } finally { f.cleanUp(); }
});

test("a response from a discarded tree cannot populate the next project", async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.tree.getItem("folder/").expand();
  await setImmediate();
  f.cleanUp();
  resolve(["folder/stale.txt"]);
  await setImmediate();
  assert.deepEqual(f.errors, []);
});
