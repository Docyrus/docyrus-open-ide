import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(
  new URL("../node_modules/@native-sdk/cli/src/platform/macos/appkit_host.m", import.meta.url),
);
const source = readFileSync(target, "utf8");
const marker = "// Docyrus forwards Finder/Open With document requests through the existing file event seam.";

if (!source.includes(marker)) {
  const insertionPoint = "@implementation NativeSdkAppDelegate\n\n";
  const implementation = `${insertionPoint}${marker}
- (void)application:(NSApplication *)sender openFiles:(NSArray<NSString *> *)filenames {
    NSMutableArray<NSURL *> *urls = [NSMutableArray arrayWithCapacity:filenames.count];
    for (NSString *filename in filenames) {
        if (filename.length > 0) [urls addObject:[NSURL fileURLWithPath:filename]];
    }
    const BOOL accepted = [self.host emitDroppedFileURLs:urls
                                                windowId:1
                                               viewLabel:@"__docyrus_open_files__"
                                                   point:NSMakePoint(-1, -1)];
    [sender replyToOpenOrPrint:accepted ? NSApplicationDelegateReplySuccess : NSApplicationDelegateReplyFailure];
}

`;
  if (!source.includes(insertionPoint)) {
    throw new Error("The Native SDK AppKit delegate changed; update the Docyrus open-document patch.");
  }
  writeFileSync(target, source.replace(insertionPoint, implementation));
}
