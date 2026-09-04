import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL(
    "../node_modules/@native-sdk/cli/src/platform/macos/appkit_host.m",
    import.meta.url,
  ),
);

const source = readFileSync(target, "utf8");
const marker = "// Docyrus: mirroring the covers costs a cross-process";

if (!source.includes(marker)) {
  const original = `        if (isWebView) {
            NativeSdkWebView *webView = (NativeSdkWebView *)coveredView;
            webView.coveredMouseRects = coveredRects;
            [self applyCoveredMouseRects:coveredRects toWebView:webView];`;

  const replacement = `        if (isWebView) {
            NativeSdkWebView *webView = (NativeSdkWebView *)coveredView;
            // Docyrus: mirroring the covers costs a cross-process
            // evaluateJavaScript per webview, and this pass runs on every
            // webview frame push - roughly 25 calls a frame while a splitter
            // drags. Docyrus tiles its panes, so the list is empty in the
            // common case and the injected script just early-returns.
            // Skip only the empty -> empty edge: a navigation that wipes
            // real covers still gets them re-injected on the next pass,
            // because an empty list leaves nothing to restore.
            NSArray<NSValue *> *previousCoveredRects = webView.coveredMouseRects;
            if (previousCoveredRects != nil && previousCoveredRects.count == 0 && coveredRects.count == 0) continue;
            webView.coveredMouseRects = coveredRects;
            [self applyCoveredMouseRects:coveredRects toWebView:webView];`;

  if (!source.includes(original)) {
    throw new Error(
      "The installed Native SDK covered-rect mirror changed; update the Docyrus covered-rects patch before building.",
    );
  }

  writeFileSync(target, source.replace(original, replacement));
}
