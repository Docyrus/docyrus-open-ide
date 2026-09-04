import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL(
    "../node_modules/@native-sdk/cli/src/platform/macos/appkit_host.m",
    import.meta.url,
  ),
);

const source = readFileSync(target, "utf8");
const marker = "// Docyrus: addSubview:positioned:relativeTo: MOVES a view";

if (!source.includes(marker)) {
  const original = `    NSView *previous = nil;
    for (NSView *view in views) {
        [contentView addSubview:view positioned:NSWindowAbove relativeTo:previous];
        previous = view;
    }
    [self updateCoveredMouseRectsInWindow:windowId];`;

  const replacement = `    // Docyrus: addSubview:positioned:relativeTo: MOVES a view that is already
    // a subview, which detaches and re-attaches the WKWebView's remote layer
    // hosting - a visible white flash. This pass runs on every webview frame
    // push (so on every tick of a splitter drag) and touches EVERY webview,
    // which is why moving one pane flickered all of them. Skip it when the
    // subviews already sit in the order the sort just produced: the ordering
    // loop's invariant is exactly that the members of \`views\` appear at
    // strictly ascending subview indices.
    BOOL orderAlreadyApplied = YES;
    NSInteger lastSubviewIndex = -1;
    for (NSView *view in views) {
        NSUInteger subviewIndex = [contentView.subviews indexOfObjectIdenticalTo:view];
        if (subviewIndex == NSNotFound || (NSInteger)subviewIndex <= lastSubviewIndex) {
            orderAlreadyApplied = NO;
            break;
        }
        lastSubviewIndex = (NSInteger)subviewIndex;
    }
    if (!orderAlreadyApplied) {
        NSView *previous = nil;
        for (NSView *view in views) {
            [contentView addSubview:view positioned:NSWindowAbove relativeTo:previous];
            previous = view;
        }
    }
    [self updateCoveredMouseRectsInWindow:windowId];`;

  if (!source.includes(original)) {
    throw new Error(
      "The installed Native SDK webview reorder pass changed; update the Docyrus webview-reorder patch before building.",
    );
  }

  writeFileSync(target, source.replace(original, replacement));
}
