#include "remote_client.h"
#include <libssh2.h>
#include <libssh2_sftp.h>
#include <openssl/rand.h>
#include <openssl/evp.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

struct DocyrusRemote {
    int socket;
    LIBSSH2_SESSION *session;
    LIBSSH2_SFTP *sftp;
    char root[2048];
    char error[512];
};

static pthread_once_t ssh_once = PTHREAD_ONCE_INIT;
static int ssh_init_result;
static void ssh_init(void) { ssh_init_result = libssh2_init(0); }

/* libssh2's known-host parser does not enforce OpenSSH @revoked markers.
   Refuse a revoked key even when another line still lists it as trusted. */
static int revoked_key(const char *path, const char *key, size_t length) {
    if (length > 16384) return 1;
    FILE *file = fopen(path, "r");
    if (!file) return 0;
    unsigned char encoded[21849];
    int encoded_len = EVP_EncodeBlock(encoded, (const unsigned char *)key, (int)length);
    char line[32768];
    int revoked = 0;
    while (fgets(line, sizeof(line), file)) {
        char *save = NULL;
        char *marker = strtok_r(line, " \t\r\n", &save);
        if (!marker || strcmp(marker, "@revoked")) continue;
        if (!strtok_r(NULL, " \t\r\n", &save) || !strtok_r(NULL, " \t\r\n", &save)) continue;
        char *value = strtok_r(NULL, " \t\r\n", &save);
        if (value && strlen(value) == (size_t)encoded_len && !memcmp(value, encoded, (size_t)encoded_len)) { revoked = 1; break; }
    }
    fclose(file);
    return revoked;
}

static int failure(DocyrusRemote *r, const char *operation) {
    unsigned long status = libssh2_sftp_last_error(r->sftp);
    snprintf(r->error, sizeof(r->error), "%s failed (SFTP %lu). Reconnect if the server is unavailable.", operation, status);
    if (status == LIBSSH2_FX_NO_SUCH_FILE || status == LIBSSH2_FX_NO_SUCH_PATH) return DR_NOT_FOUND;
    if (status == LIBSSH2_FX_FILE_ALREADY_EXISTS) return DR_EXISTS;
    return DR_ERROR;
}

void dr_disconnect(DocyrusRemote *r) {
    if (!r) return;
    if (r->session) libssh2_session_set_timeout(r->session, 250);
    if (r->sftp) libssh2_sftp_shutdown(r->sftp);
    if (r->session) {
        libssh2_session_disconnect(r->session, "Project disconnected");
        libssh2_session_free(r->session);
    }
    if (r->socket >= 0) close(r->socket);
    free(r);
}

DocyrusRemote *dr_connect(const char *host, unsigned short port, const char *user,
                          const char *root, const char *known_hosts, char *error, size_t capacity) {
    pthread_once(&ssh_once, ssh_init);
    DocyrusRemote *r = calloc(1, sizeof(*r));
    if (!r) { snprintf(error, capacity, "Out of memory."); return NULL; }
    r->socket = -1;
    snprintf(r->error, sizeof(r->error), "Cannot initialize SSH.");
    if (ssh_init_result) goto fail;
    struct addrinfo hints = {0}, *addresses = NULL;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    char service[8];
    snprintf(service, sizeof(service), "%u", port);
    if (getaddrinfo(host, service, &hints, &addresses)) {
        snprintf(r->error, sizeof(r->error), "Cannot resolve the SSH hostname.");
        goto fail;
    }
    for (struct addrinfo *a = addresses; a; a = a->ai_next) {
        int fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (fd < 0) continue;
        int flags = fcntl(fd, F_GETFL, 0), one = 1;
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        int rc = connect(fd, a->ai_addr, a->ai_addrlen);
        if (rc && errno == EINPROGRESS) {
            struct pollfd p = { .fd = fd, .events = POLLOUT };
            int status = 1;
            socklen_t len = sizeof(status);
            if (poll(&p, 1, 8000) > 0 && !getsockopt(fd, SOL_SOCKET, SO_ERROR, &status, &len) && !status) rc = 0;
        }
        if (!rc) { fcntl(fd, F_SETFL, flags); r->socket = fd; break; }
        close(fd);
    }
    freeaddrinfo(addresses);
    if (r->socket < 0) {
        snprintf(r->error, sizeof(r->error), "Cannot reach the SSH server. Check the host, port, and network.");
        goto fail;
    }
    r->session = libssh2_session_init();
    if (!r->session) goto fail;
    libssh2_session_set_timeout(r->session, 10000);
    libssh2_session_set_blocking(r->session, 1);
    if (libssh2_session_handshake(r->session, r->socket)) {
        char *detail = NULL;
        libssh2_session_last_error(r->session, &detail, NULL, 0);
        snprintf(r->error, sizeof(r->error), "SSH handshake failed: %.400s", detail ? detail : "timed out");
        goto fail;
    }
    /* Verify BEFORE sending any authentication material. Never accept a changed key. */
    LIBSSH2_KNOWNHOSTS *hosts = libssh2_knownhost_init(r->session);
    if (!hosts) goto fail;
    size_t key_len = 0;
    int key_type = 0;
    const char *key = libssh2_session_hostkey(r->session, &key_len, &key_type);
    if (key && revoked_key(known_hosts, key, key_len)) {
        libssh2_knownhost_free(hosts);
        snprintf(r->error, sizeof(r->error), "SSH host key is revoked in ~/.ssh/known_hosts. Verify the server with its administrator.");
        goto fail;
    }
    int known = LIBSSH2_KNOWNHOST_CHECK_FAILURE;
    if (key && libssh2_knownhost_readfile(hosts, known_hosts, LIBSSH2_KNOWNHOST_FILE_OPENSSH) >= 0)
        known = libssh2_knownhost_checkp(hosts, host, port, key, key_len,
            LIBSSH2_KNOWNHOST_TYPE_PLAIN | LIBSSH2_KNOWNHOST_KEYENC_RAW, NULL);
    libssh2_knownhost_free(hosts);
    if (known != LIBSSH2_KNOWNHOST_CHECK_MATCH) {
        snprintf(r->error, sizeof(r->error), "%s", known == LIBSSH2_KNOWNHOST_CHECK_MISMATCH
            ? "SSH host key has changed. Verify the server identity and update ~/.ssh/known_hosts before reconnecting."
            : "SSH host is not trusted. Connect with OpenSSH in a terminal, verify its fingerprint, then retry. This client reads ~/.ssh/known_hosts.");
        goto fail;
    }
    LIBSSH2_AGENT *agent = libssh2_agent_init(r->session);
    int authenticated = 0;
    if (agent) {
        if (!libssh2_agent_connect(agent) && !libssh2_agent_list_identities(agent)) {
            struct libssh2_agent_publickey *identity = NULL, *previous = NULL;
            for (int count = 0; count < 64 && !libssh2_agent_get_identity(agent, &identity, previous); count++) {
                if (!libssh2_agent_userauth(agent, user, identity)) { authenticated = 1; break; }
                previous = identity;
            }
        }
        libssh2_agent_disconnect(agent);
        libssh2_agent_free(agent);
    }
    if (!authenticated) {
        snprintf(r->error, sizeof(r->error), "SSH-agent authentication failed. Load your key with ssh-add and check the username. Password authentication is available in the SSH terminal.");
        goto fail;
    }
    r->sftp = libssh2_sftp_init(r->session);
    if (!r->sftp) {
        snprintf(r->error, sizeof(r->error), "The server could not start SFTP.");
        goto fail;
    }
    int n = libssh2_sftp_realpath(r->sftp, root, r->root, sizeof(r->root) - 1);
    if (n <= 0 || (size_t)n >= sizeof(r->root) - 1 || r->root[0] != '/') {
        snprintf(r->error, sizeof(r->error), "Remote folder does not exist or cannot be resolved.");
        goto fail;
    }
    r->root[n] = 0;
    while (n > 1 && r->root[n - 1] == '/') r->root[--n] = 0;
    LIBSSH2_SFTP_HANDLE *dir = libssh2_sftp_opendir(r->sftp, r->root);
    if (!dir) {
        snprintf(r->error, sizeof(r->error), "Remote folder is not a readable directory.");
        goto fail;
    }
    libssh2_sftp_closedir(dir);
    return r;
fail:
    snprintf(error, capacity, "%s", r->error);
    dr_disconnect(r);
    return NULL;
}

int dr_alive(DocyrusRemote *r) {
    int last = libssh2_session_last_errno(r->session);
    if (last == LIBSSH2_ERROR_SOCKET_DISCONNECT || last == LIBSSH2_ERROR_SOCKET_SEND ||
        last == LIBSSH2_ERROR_SOCKET_RECV || last == LIBSSH2_ERROR_TIMEOUT) return 0;
    char c;
    ssize_t n = recv(r->socket, &c, 1, MSG_PEEK | MSG_DONTWAIT);
    return n > 0 || (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
}
const char *dr_error(DocyrusRemote *r) { return r->error; }

/* SFTP v3 has no openat/no-follow primitive. Refuse symlink components and
   canonicalize the root; a hostile server remains outside this trust boundary. */
static int path_for(DocyrusRemote *r, const char *relative, char *absolute, int allow_missing) {
    size_t root_len = strlen(r->root), length = strlen(relative);
    if (length + root_len + 2 >= 4096 || relative[0] == '/' || strchr(relative, '\\')) return DR_UNSAFE;
    memcpy(absolute, r->root, root_len);
    size_t end = root_len;
    if (!length) { absolute[end] = 0; return 0; }
    const char *part = relative;
    while (*part) {
        const char *slash = strchr(part, '/');
        size_t size = slash ? (size_t)(slash - part) : strlen(part);
        if (!size || (size == 1 && part[0] == '.') || (size == 2 && !memcmp(part, "..", 2))) return DR_UNSAFE;
        for (size_t i = 0; i < size; i++) if ((unsigned char)part[i] < 32 || part[i] == 127) return DR_UNSAFE;
        if (end > 1) absolute[end++] = '/';
        memcpy(absolute + end, part, size);
        end += size;
        absolute[end] = 0;
        LIBSSH2_SFTP_ATTRIBUTES attrs = {0};
        if (libssh2_sftp_lstat(r->sftp, absolute, &attrs)) {
            int rc = failure(r, "Inspect path");
            if (!slash && allow_missing && rc == DR_NOT_FOUND) return 0;
            return rc;
        }
        if (!(attrs.flags & LIBSSH2_SFTP_ATTR_PERMISSIONS) || LIBSSH2_SFTP_S_ISLNK(attrs.permissions)) return DR_UNSAFE;
        if (slash && !LIBSSH2_SFTP_S_ISDIR(attrs.permissions)) return DR_UNSAFE;
        part += size;
        if (*part) part++;
    }
    return 0;
}

int dr_stat(DocyrusRemote *r, const char *path, int *directory) {
    char absolute[4096];
    int rc = path_for(r, path, absolute, 0);
    if (rc) return rc;
    LIBSSH2_SFTP_ATTRIBUTES attrs = {0};
    if (libssh2_sftp_lstat(r->sftp, absolute, &attrs)) return failure(r, "Stat");
    *directory = LIBSSH2_SFTP_S_ISDIR(attrs.permissions);
    return 0;
}
void *dr_opendir(DocyrusRemote *r, const char *path) {
    char absolute[4096];
    if (path_for(r, path, absolute, 0)) return NULL;
    return libssh2_sftp_opendir(r->sftp, absolute);
}
int dr_readdir(DocyrusRemote *r, void *handle, char *name, size_t capacity, int *directory) {
    LIBSSH2_SFTP_ATTRIBUTES attrs = {0};
    int n = libssh2_sftp_readdir_ex(handle, name, capacity - 1, NULL, 0, &attrs);
    if (n < 0) return failure(r, "Read directory");
    if (!n) return 0;
    if ((size_t)n >= capacity || memchr(name, 0, (size_t)n)) return DR_UNSAFE;
    name[n] = 0;
    if (!(attrs.flags & LIBSSH2_SFTP_ATTR_PERMISSIONS)) return 2;
    *directory = LIBSSH2_SFTP_S_ISDIR(attrs.permissions) ? 1 : (LIBSSH2_SFTP_S_ISREG(attrs.permissions) ? 0 : -1);
    return 1;
}
void dr_closedir(void *handle) { libssh2_sftp_closedir(handle); }

int dr_read(DocyrusRemote *r, const char *path, char *buffer, size_t capacity, size_t *length) {
    char absolute[4096];
    int rc = path_for(r, path, absolute, 0);
    if (rc) return rc;
    LIBSSH2_SFTP_HANDLE *file = libssh2_sftp_open(r->sftp, absolute, LIBSSH2_FXF_READ, 0);
    if (!file) return failure(r, "Open file");
    *length = 0;
    while (*length < capacity) {
        ssize_t n = libssh2_sftp_read(file, buffer + *length, capacity - *length);
        if (n < 0) { rc = failure(r, "Read file"); break; }
        if (!n) break;
        *length += (size_t)n;
    }
    if (!rc && *length == capacity) {
        char extra;
        ssize_t n = libssh2_sftp_read(file, &extra, 1);
        if (n > 0) rc = DR_TOO_LARGE;
        else if (n < 0) rc = failure(r, "Read file");
    }
    if (libssh2_sftp_close(file) && !rc) rc = failure(r, "Close file");
    return rc;
}

int dr_write(DocyrusRemote *r, const char *path, const char *data, size_t length, int exclusive) {
    char absolute[4096], temporary[4160];
    if (!path[0]) return DR_UNSAFE;
    int rc = path_for(r, path, absolute, 1);
    if (rc) return rc;
    LIBSSH2_SFTP_ATTRIBUTES attrs = {0};
    int exists = !libssh2_sftp_lstat(r->sftp, absolute, &attrs);
    if (exists && exclusive) return DR_EXISTS;
    if (exists && !LIBSSH2_SFTP_S_ISREG(attrs.permissions)) return DR_UNSAFE;
    if (!exists && libssh2_sftp_last_error(r->sftp) != LIBSSH2_FX_NO_SUCH_FILE) return failure(r, "Inspect destination");
    unsigned char random[12];
    if (RAND_bytes(random, sizeof(random)) != 1) return DR_ERROR;
    char hex[25];
    for (size_t i = 0; i < sizeof(random); i++) snprintf(hex + 2 * i, 3, "%02x", random[i]);
    snprintf(temporary, sizeof(temporary), "%s.docyrus-%s.tmp", absolute, hex);
    unsigned long mode = exists ? (attrs.permissions & 0777) : 0644;
    LIBSSH2_SFTP_HANDLE *file = libssh2_sftp_open(r->sftp, temporary,
        LIBSSH2_FXF_WRITE | LIBSSH2_FXF_CREAT | LIBSSH2_FXF_EXCL, (long)mode);
    if (!file) return failure(r, "Create temporary file");
    size_t offset = 0;
    while (offset < length) {
        ssize_t n = libssh2_sftp_write(file, data + offset, length - offset);
        if (n <= 0) { rc = failure(r, "Upload file"); break; }
        offset += (size_t)n;
    }
    if (libssh2_sftp_close(file) && !rc) rc = failure(r, "Close upload");
    if (!rc) {
        /* Exclusive create uses standard rename so a racing destination wins.
           Saves require the atomic OpenSSH extension; never truncate in place. */
        int renamed = exclusive ? libssh2_sftp_rename_ex(r->sftp, temporary, (unsigned)strlen(temporary), absolute, (unsigned)strlen(absolute), 0)
                                : libssh2_sftp_posix_rename(r->sftp, temporary, absolute);
        if (renamed) rc = failure(r, "Atomic save (requires posix-rename@openssh.com)");
    }
    if (rc) libssh2_sftp_unlink(r->sftp, temporary);
    return rc;
}

int dr_mkdir(DocyrusRemote *r, const char *path) {
    char absolute[4096];
    if (!path[0]) return DR_UNSAFE;
    int rc = path_for(r, path, absolute, 1);
    if (rc) return rc;
    return libssh2_sftp_mkdir(r->sftp, absolute, 0755) ? failure(r, "Create directory") : 0;
}
int dr_rename(DocyrusRemote *r, const char *from, const char *to) {
    char source[4096], destination[4096];
    if (!from[0] || !to[0]) return DR_UNSAFE;
    int rc = path_for(r, from, source, 0);
    if (rc) return rc;
    rc = path_for(r, to, destination, 1);
    if (rc) return rc;
    LIBSSH2_SFTP_ATTRIBUTES attrs = {0};
    if (!libssh2_sftp_lstat(r->sftp, destination, &attrs)) return DR_EXISTS;
    if (libssh2_sftp_last_error(r->sftp) != LIBSSH2_FX_NO_SUCH_FILE) return failure(r, "Inspect destination");
    return libssh2_sftp_rename_ex(r->sftp, source, (unsigned)strlen(source), destination, (unsigned)strlen(destination), 0) ? failure(r, "Rename") : 0;
}
int dr_remove(DocyrusRemote *r, const char *path, int directory) {
    char absolute[4096];
    if (!path[0]) return DR_UNSAFE;
    int rc = path_for(r, path, absolute, 0);
    if (rc) return rc;
    rc = directory ? libssh2_sftp_rmdir(r->sftp, absolute) : libssh2_sftp_unlink(r->sftp, absolute);
    return rc ? failure(r, "Delete") : 0;
}
