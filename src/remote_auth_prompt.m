#import <AppKit/AppKit.h>
#include <string.h>

@interface DocyrusAuthRequest : NSObject
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic, strong) NSAlert *alert;
@property(nonatomic, strong) NSMutableData *response;
@property BOOL completed;
@property BOOL accepted;
@end
@implementation DocyrusAuthRequest
@end

static NSLock *requestsLock;
static NSMutableSet<DocyrusAuthRequest *> *requests;
static BOOL stopping;

static void initializeRequests(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        requestsLock = [NSLock new];
        requests = [NSMutableSet new];
    });
}

/* A worker owns the response. Only the masked AppKit control sees input;
   password bytes never travel through the model, bridge, or replay journal. */
int docyrus_remote_auth_prompt(void *context, const char *user, const char *host,
                               const char *instruction, const char *prompt,
                               char *response, size_t capacity) {
    (void)context;
    if ([NSThread isMainThread] || !capacity) return 0;
    @autoreleasepool {
        initializeRequests();
        DocyrusAuthRequest *request = [DocyrusAuthRequest new];
        request.condition = [NSCondition new];
        NSString *username = [NSString stringWithUTF8String:user] ?: @"";
        NSString *hostname = [NSString stringWithUTF8String:host] ?: @"";
        NSString *details = [NSString stringWithUTF8String:instruction] ?: @"";
        NSString *question = [NSString stringWithUTF8String:prompt] ?: @"Password";
        [requestsLock lock];
        if (stopping) { [requestsLock unlock]; return 0; }
        [requests addObject:request];
        [requestsLock unlock];

        dispatch_async(dispatch_get_main_queue(), ^{
            [request.condition lock];
            if (request.completed) { [request.condition unlock]; return; }
            NSWindow *parent = NSApp.keyWindow ?: NSApp.mainWindow;
            if (!parent) {
                request.completed = YES;
                [request.condition signal];
                [request.condition unlock];
                return;
            }
            NSAlert *alert = [NSAlert new];
            alert.messageText = [NSString stringWithFormat:@"Sign in to %@@%@", username, hostname];
            alert.informativeText = [NSString stringWithFormat:@"%@\n\n%@", details, question];
            [alert addButtonWithTitle:@"Connect"];
            [alert addButtonWithTitle:@"Cancel"];
            NSSecureTextField *field = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 0, 340, 28)];
            field.placeholderString = question;
            [field setAccessibilityLabel:question];
            alert.accessoryView = field;
            alert.window.initialFirstResponder = field;
            request.alert = alert;
            [request.condition unlock];
            [alert beginSheetModalForWindow:parent completionHandler:^(NSModalResponse result) {
                [request.condition lock];
                if (!request.completed) {
                    request.accepted = result == NSAlertFirstButtonReturn;
                    if (request.accepted) {
                        NSData *bytes = [field.stringValue dataUsingEncoding:NSUTF8StringEncoding];
                        request.response = [bytes mutableCopy];
                    }
                    request.completed = YES;
                    [request.condition signal];
                }
                field.stringValue = @"";
                request.alert = nil;
                [request.condition unlock];
            }];
            [alert.window makeFirstResponder:field];
        });

        [request.condition lock];
        while (!request.completed) [request.condition wait];
        int accepted = request.accepted && request.response.length < capacity;
        if (accepted) {
            memcpy(response, request.response.bytes, request.response.length);
            response[request.response.length] = 0;
        }
        volatile unsigned char *bytes = request.response.mutableBytes;
        for (NSUInteger i = 0; i < request.response.length; i++) bytes[i] = 0;
        request.response = nil;
        [request.condition unlock];
        [requestsLock lock];
        [requests removeObject:request];
        [requestsLock unlock];
        return accepted;
    }
}

/* Called on the main thread before joining authentication workers at shutdown. */
void docyrus_remote_cancel_auth_prompts(void) {
    initializeRequests();
    [requestsLock lock];
    stopping = YES;
    NSArray<DocyrusAuthRequest *> *pending = requests.allObjects;
    [requestsLock unlock];
    for (DocyrusAuthRequest *request in pending) {
        [request.condition lock];
        request.accepted = NO;
        request.completed = YES;
        [request.condition signal];
        NSAlert *alert = request.alert;
        request.alert = nil;
        [request.condition unlock];
        if (alert.window.sheetParent) [alert.window.sheetParent endSheet:alert.window returnCode:NSAlertSecondButtonReturn];
        [alert.window orderOut:nil];
    }
}
