import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL(
    "../node_modules/@native-sdk/cli/src/platform/macos/appkit_host.m",
    import.meta.url,
  ),
);

const source = readFileSync(target, "utf8");
const marker = "// Docyrus: the horizontal overlay scroller is suppressed";

if (!source.includes(marker)) {
  const originalCreate = `            driver.hasHorizontalScroller = YES;
            driver.scrollerStyle = NSScrollerStyleOverlay;`;

  const replacementCreate = `            // Docyrus: the horizontal overlay scroller is suppressed app-wide.
            // Every horizontally scrolling region in this app is a 24pt pane
            // tab strip, where a 15pt overlay bar lands on top of the tab
            // labels while a scroll is in flight. Omitting the NSScroller
            // subview removes only the chrome - the clip view still scrolls on
            // wheel, trackpad, keyboard, and programmatic reveal, and wheel
            // ownership reads \`grantsX\` below rather than this flag. Revisit
            // if the app ever gains a wide horizontal region (a no-wrap
            // \`code\` block, say) that wants a visible bar.
            driver.hasHorizontalScroller = NO;
            driver.scrollerStyle = NSScrollerStyleOverlay;`;

  const originalReconcile = `        if (driver.hasHorizontalScroller != (desired.scrolls_x != 0)) driver.hasHorizontalScroller = desired.scrolls_x != 0;`;

  const replacementReconcile = `        // Docyrus: pinned off - see the creation-time note above. The grant
        // itself still rides the view, so per-axis wheel routing is untouched.
        if (driver.hasHorizontalScroller) driver.hasHorizontalScroller = NO;`;

  if (!source.includes(originalCreate) || !source.includes(originalReconcile)) {
    throw new Error(
      "The installed Native SDK scroll-driver scroller setup changed; update the Docyrus hide-scrollbars patch before building.",
    );
  }

  writeFileSync(
    target,
    source
      .replace(originalCreate, replacementCreate)
      .replace(originalReconcile, replacementReconcile),
  );
}
