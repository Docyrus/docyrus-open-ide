#ifndef DOCYRUS_REMOTE_CLIENT_H
#define DOCYRUS_REMOTE_CLIENT_H
#include <stddef.h>
#include <stdint.h>

typedef struct DocyrusRemote DocyrusRemote;
enum { DR_ERROR = -1, DR_NOT_FOUND = -2, DR_EXISTS = -3, DR_UNSAFE = -4, DR_TOO_LARGE = -5,
       DR_AUTH_REQUIRED = -6, DR_AUTH_CANCELLED = -7 };
/* Return 1 with a UTF-8 response, or 0 to cancel. Invoked only after host verification. */
typedef int (*DR_AUTH_PROMPT)(void *context, const char *user, const char *host,
                              const char *instruction, const char *prompt,
                              char *response, size_t capacity);
/* All paths are relative to the canonical project root. Symlinks are refused. */
DocyrusRemote *dr_connect(const char *host, unsigned short port, const char *user,
                          const char *root, const char *known_hosts, char *error, size_t capacity);
DocyrusRemote *dr_connect_auth(const char *host, unsigned short port, const char *user,
                              const char *root, const char *known_hosts,
                              DR_AUTH_PROMPT prompt, void *context, int *auth_status,
                              char *error, size_t capacity);
void dr_disconnect(DocyrusRemote *remote);
int dr_alive(DocyrusRemote *remote);
const char *dr_error(DocyrusRemote *remote);
int dr_stat(DocyrusRemote *remote, const char *path, int *directory);
void *dr_opendir(DocyrusRemote *remote, const char *path);
int dr_readdir(DocyrusRemote *remote, void *handle, char *name, size_t capacity, int *directory);
void dr_closedir(void *handle);
int dr_read(DocyrusRemote *remote, const char *path, char *buffer, size_t capacity, size_t *length);
int dr_write(DocyrusRemote *remote, const char *path, const char *data, size_t length, int exclusive);
int dr_mkdir(DocyrusRemote *remote, const char *path);
int dr_rename(DocyrusRemote *remote, const char *from, const char *to);
int dr_remove(DocyrusRemote *remote, const char *path, int directory);
#endif
