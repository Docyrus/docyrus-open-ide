export function observeRemoteFolders(currentTree, initialPaths, options) {
  let expanded = new Set();
  let queue = Promise.resolve();
  let active = true;
  const children = new Map();
  const directories = new Set(initialPaths.filter(path => path.endsWith("/")));
  const current = () => active && options.isCurrent();
  const unsubscribe = currentTree.subscribe(() => {
    if (!current()) return;
    for (const row of currentTree.getVisibleRows(0, currentTree.getVisibleCount())) {
      if (row.kind === "directory") directories.add(row.path);
    }
    const next = new Set([...directories].filter(path => {
      const item = currentTree.getItem(path);
      return item?.isDirectory() && item.isExpanded();
    }));
    for (const path of next) {
      if (expanded.has(path)) continue;
      queue = queue.then(async () => {
        if (!current()) return;
        const item = currentTree.getItem(path);
        if (!item?.isDirectory() || !item.isExpanded()) return;
        const ticket = options.onLoading(path);
        try {
          const listing = await options.loadDirectory(path);
          if (!current() || !currentTree.getItem(path)?.isDirectory()) return;
          const fresh = new Set(listing.paths);
          const operations = [];
          for (const previous of children.get(path) || []) {
            if (!fresh.has(previous)) {
              if (currentTree.getItem(previous)) operations.push({ type: "remove", path: previous, recursive: true });
              if (previous.endsWith("/")) for (const directory of directories) {
                if (directory.startsWith(previous)) { directories.delete(directory); children.delete(directory); }
              }
            }
          }
          for (const child of fresh) {
            if (child.endsWith("/")) directories.add(child);
            if (!currentTree.getItem(child)) operations.push({ type: "add", path: child });
          }
          currentTree.batch(operations);
          children.set(path, fresh);
          options.onLoaded(path, listing, ticket);
        } catch (error) {
          if (current()) options.onError(path, error);
        }
      });
    }
    expanded = next;
  });
  return () => { active = false; unsubscribe(); };
}
