import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PDF preview, rendered by the system WebView itself.
//
// WKWebView has a real PDF viewer -- it is what Safari shows -- and it engages
// for a TOP-LEVEL document served as `application/pdf`. So a PDF pane is not an
// embed inside the Monaco page: the pane's WebView navigates straight at the
// file, and WebKit streams and paginates it with scrolling, zoom, search and
// text selection for free. Nothing has to read the bytes into JavaScript, which
// is what makes a 40 MB PDF open as fast as a 40 KB one.
//
// The obstacle is reach: `zero://app` serves the packaged `dist` directory, and
// a user's PDF is anywhere on disk. This patch adds one narrow door beside it.
//
// 1. A RESERVED PREFIX. `zero://app/~preview/<slot>` resolves through a table
//    the app publishes, never through the URL's own text. The URL therefore
//    carries no path at all -- there is no traversal to reason about, no
//    encoding to get wrong, and a page cannot name a file the app did not
//    already put in a pane. Slots are the four editor panes; a `?v=` token the
//    handler ignores makes the URL change when the pane's file does.
//
// 2. AN EXACT, LIVE TABLE. `native_sdk_appkit_set_preview_files` replaces the
//    whole table, and the app republishes it whenever a pane's tab changes, so
//    the door closes behind a closed tab. Empty slots resolve to nothing.
//
// 3. A MIME TYPE. The asset handler answered `application/octet-stream` for
//    `.pdf`, which makes WebKit offer a download instead of rendering it.
//
// The prefix is deliberately not a project root: a root would let any page in
// the WebViews read every file in the workspace, while a slot table reaches
// exactly the files the user has open in a pane.

const mimeOriginal = `    if ([ext isEqualToString:@"wasm"]) return @"application/wasm";`;
const mimeReplacement = `    if ([ext isEqualToString:@"wasm"]) return @"application/wasm";
    // Docyrus: WebKit renders a PDF inline only when it is typed as one;
    // as octet-stream the same bytes become a download prompt.
    if ([ext isEqualToString:@"pdf"]) return @"application/pdf";`;

const tableMarker = "native_sdk_appkit_set_preview_files";
const tableOriginal = `@interface NativeSdkAssetSchemeHandler : NSObject <WKURLSchemeHandler>`;
const tableReplacement = `/* Docyrus: the files the app has published for \`zero://app/~preview/<slot>\`,
 * indexed by slot. This is an EXACT table, never a root: a page in a WebView
 * can reach the file a pane is showing and nothing else, and the app replaces
 * the whole table whenever a pane's tab changes, so a closed tab stops
 * resolving. Published from the app's loop thread and read on the main thread
 * by the scheme handler -- the same thread on AppKit, with the lock there for
 * the WebKit builds that hand scheme tasks to a helper queue. */
static NSArray<NSString *> *g_docyrusPreviewFiles = nil;
static NSLock *g_docyrusPreviewFilesLock = nil;

static void DocyrusPreviewFilesEnsure(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_docyrusPreviewFiles = @[];
        g_docyrusPreviewFilesLock = [[NSLock alloc] init];
    });
}

/* Replace the whole table. \`bytes\` is newline-separated absolute paths, one
 * per slot in order; an empty line is a slot that resolves to nothing. */
void native_sdk_appkit_set_preview_files(const char *bytes, size_t len) {
    DocyrusPreviewFilesEnsure();
    NSMutableArray<NSString *> *next = [NSMutableArray array];
    if (bytes && len > 0) {
        NSString *joined = [[NSString alloc] initWithBytes:bytes length:len encoding:NSUTF8StringEncoding];
        for (NSString *entry in [(joined ?: @"") componentsSeparatedByString:@"\\n"]) {
            [next addObject:[entry hasPrefix:@"/"] ? entry : @""];
        }
    }
    [g_docyrusPreviewFilesLock lock];
    g_docyrusPreviewFiles = next;
    [g_docyrusPreviewFilesLock unlock];
}

/* The absolute path a slot names, or nil when the slot is empty or absent. */
static NSString *DocyrusPreviewFileForSlot(NSString *slot) {
    if (slot.length == 0 || slot.length > 2) return nil;
    for (NSUInteger index = 0; index < slot.length; index++) {
        unichar digit = [slot characterAtIndex:index];
        if (digit < '0' || digit > '9') return nil;
    }
    DocyrusPreviewFilesEnsure();
    [g_docyrusPreviewFilesLock lock];
    NSArray<NSString *> *files = g_docyrusPreviewFiles;
    [g_docyrusPreviewFilesLock unlock];
    NSInteger index = slot.integerValue;
    if (index < 0 || index >= (NSInteger)files.count) return nil;
    NSString *path = files[(NSUInteger)index];
    return path.length > 0 ? path : nil;
}

${tableOriginal}`;

const serveMarker = "// Docyrus: the reserved preview prefix";
const serveOriginal = `- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    (void)webView;
    NSString *relativePath = NativeSdkSafeAssetPath(urlSchemeTask.request.URL, self.entryPath);`;
const serveReplacement = `- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    (void)webView;
    // Docyrus: the reserved preview prefix resolves through the app's slot
    // table rather than the asset root, and never falls back to the SPA entry
    // -- a slot that names nothing is a failed load, not a silent index.html.
    NSString *requestPath = urlSchemeTask.request.URL.path ?: @"";
    if ([requestPath hasPrefix:@"/~preview/"]) {
        NSString *slot = [requestPath substringFromIndex:[@"/~preview/" length]];
        NSString *previewPath = DocyrusPreviewFileForSlot(slot);
        NSData *previewData = previewPath ? [NSData dataWithContentsOfFile:previewPath] : nil;
        if (!previewData) {
            NSError *error = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist userInfo:nil];
            [urlSchemeTask didFailWithError:error];
            return;
        }
        NSURLResponse *previewResponse = [[NSURLResponse alloc] initWithURL:urlSchemeTask.request.URL
                                                                   MIMEType:NativeSdkMimeTypeForPath(previewPath)
                                                      expectedContentLength:(NSInteger)previewData.length
                                                           textEncodingName:nil];
        [urlSchemeTask didReceiveResponse:previewResponse];
        [urlSchemeTask didReceiveData:previewData];
        [urlSchemeTask didFinish];
        return;
    }
    NSString *relativePath = NativeSdkSafeAssetPath(urlSchemeTask.request.URL, self.entryPath);`;

const patches = [
  {
    file: "../node_modules/@native-sdk/cli/src/platform/macos/appkit_host.m",
    marker: `if ([ext isEqualToString:@"pdf"]) return @"application/pdf";`,
    original: mimeOriginal,
    replacement: mimeReplacement,
    error: "The installed Native SDK asset MIME table changed; update the Docyrus PDF-preview patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/platform/macos/appkit_host.m",
    marker: tableMarker,
    original: tableOriginal,
    replacement: tableReplacement,
    error: "The installed Native SDK asset scheme handler changed; update the Docyrus PDF-preview patch before building.",
  },
  {
    file: "../node_modules/@native-sdk/cli/src/platform/macos/appkit_host.m",
    marker: serveMarker,
    original: serveOriginal,
    replacement: serveReplacement,
    error: "The installed Native SDK asset scheme task changed; update the Docyrus PDF-preview patch before building.",
  },
];

for (const patch of patches) {
  const target = fileURLToPath(new URL(patch.file, import.meta.url));
  const source = readFileSync(target, "utf8");
  if (source.includes(patch.marker)) continue;
  if (!source.includes(patch.original)) throw new Error(patch.error);
  // A replacement is literal text, never a replace() pattern.
  writeFileSync(target, source.replace(patch.original, () => patch.replacement));
}
