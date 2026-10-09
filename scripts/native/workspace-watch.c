#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

/* Kernel vnode filters retain change flags until drained, including write/revert
 * pairs. FSEvents/FlushSync can lag completed writes and cannot certify a capture.
 * https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html
 * https://facebook.github.io/watchman/docs/cookies
 * Writable shared mappings can modify bytes without a vnode event. This is a
 * change guard for an explicitly qualified writer profile, not a filesystem
 * snapshot or an arbitrary-writer consistency certificate.
 * No paths or file contents leave the helper.
 */
#define MAX_WATCHES 65536
#define MAX_DEPTH 512
#define MAX_REVISION 9007199254740991ULL
static int queue_fd;
static size_t watch_count;
static uint64_t revision;
static bool invalid;

static void error(const char *code) {
  printf("{\"error\":\"%s\"}\n", code);
  fflush(stdout);
}

static int watch_fd(int fd, bool directory, bool ancestor) {
  if (watch_count >= MAX_WATCHES) { error("watch-limit"); return -1; }
  unsigned int flags = NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE;
  if (!ancestor) flags |= NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB | NOTE_LINK;
  struct kevent change;
  EV_SET(&change, fd, EVFILT_VNODE, EV_ADD | EV_CLEAR, flags, 0,
         (void *)(uintptr_t)(directory ? 1 : 0));
  if (kevent(queue_fd, &change, 1, NULL, 0, NULL) < 0) { error("registration-failed"); return -1; }
  watch_count++;
  return 0;
}

/* Every directory is registered BEFORE enumeration. A subsequent entry change
 * invalidates this watch, because newly added/replaced entries are not covered.
 * Traversal never follows symlinks and refuses special files and nested mounts.
 */
static int watch_tree(int parent, const char *name, dev_t device, unsigned int depth) {
  if (depth > MAX_DEPTH) { error("depth-limit"); return -1; }
  struct stat info;
  int fd = openat(parent, name, O_EVTONLY | O_SYMLINK | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &info) < 0) {
    if (fd >= 0) close(fd);
    error(errno == EMFILE || errno == ENFILE ? "watch-limit" : "entry-unavailable");
    return -1;
  }
  if (info.st_dev != device || (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode) && !S_ISLNK(info.st_mode))) {
    close(fd); error("unsupported-entry"); return -1;
  }
  if (watch_fd(fd, S_ISDIR(info.st_mode), false) < 0) { close(fd); return -1; }
  if (!S_ISDIR(info.st_mode)) return 0;
  int scan_fd = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  DIR *directory = scan_fd < 0 ? NULL : fdopendir(scan_fd);
  if (!directory) {
    if (scan_fd >= 0) close(scan_fd);
    error("directory-unavailable"); return -1;
  }
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) {
      int saved = errno;
      closedir(directory);
      if (saved) { error("directory-unavailable"); return -1; }
      return 0;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (watch_tree(fd, entry->d_name, device, depth + 1) < 0) { closedir(directory); return -1; }
  }
}

static int watch_ancestors(const char *root) {
  char *path = strdup(root);
  if (!path) return -1;
  char *slash;
  while ((slash = strrchr(path, '/')) != NULL && slash != path) {
    *slash = '\0';
    int fd = open(path, O_EVTONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || watch_fd(fd, true, true) < 0) {
      if (fd >= 0) close(fd);
      free(path); error("ancestor-unavailable"); return -1;
    }
  }
  free(path);
  return 0;
}

static void report(uint64_t id) {
  struct timespec immediate = {0};
  struct kevent events[256];
  /* A busy writer must not monopolize the control channel indefinitely. */
  size_t drained = 0;
  for (;;) {
    int count = kevent(queue_fd, NULL, 0, events, 256, &immediate);
    if (count < 0) {
      if (errno == EINTR) continue;
      invalid = true;
      break;
    }
    for (int i = 0; i < count; i++) {
      if (revision == MAX_REVISION) invalid = true;
      else revision++;
      unsigned int flags = events[i].fflags;
      if ((events[i].flags & (EV_ERROR | EV_EOF)) ||
          (flags & (NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE)) ||
          (events[i].udata && (flags & (NOTE_WRITE | NOTE_EXTEND | NOTE_LINK)))) invalid = true;
    }
    drained += (size_t)count;
    if (count == 0) break;
    if (drained > MAX_WATCHES * 2) { invalid = true; break; }
  }
  printf("{\"id\":%" PRIu64 ",\"revision\":%" PRIu64 ",\"overflow\":%s}\n",
         id, revision, invalid ? "true" : "false");
  fflush(stdout);
}

int main(int argc, char **argv) {
  if (argc < 2 || argc > 65) return 2;
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) == 0) {
    rlim_t desired = MAX_WATCHES + MAX_DEPTH + 16;
    if (desired > limit.rlim_max) desired = limit.rlim_max;
    if (limit.rlim_cur < desired) { limit.rlim_cur = desired; (void)setrlimit(RLIMIT_NOFILE, &limit); }
  }
  queue_fd = kqueue();
  if (queue_fd < 0) { error("queue-unavailable"); return 2; }
  for (int i = 1; i < argc; i++) {
    struct stat info;
    struct statfs filesystem;
    if (argv[i][0] != '/' || lstat(argv[i], &info) < 0 || !S_ISDIR(info.st_mode) ||
        statfs(argv[i], &filesystem) < 0 || !(filesystem.f_flags & MNT_LOCAL) ||
        strcmp(filesystem.f_fstypename, "apfs") != 0) {
      error("unsupported-filesystem"); return 2;
    }
    if (watch_ancestors(argv[i]) < 0 || watch_tree(AT_FDCWD, argv[i], info.st_dev, 0) < 0) return 2;
  }
  /* Registration of the full tree and its ancestors precedes acknowledgement. */
  report(0);
  char line[96];
  while (fgets(line, sizeof(line), stdin)) {
    size_t size = strlen(line);
    if (size < 8 || line[size - 1] != '\n' || strncmp(line, "flush ", 6) != 0) return 2;
    char *end = NULL;
    errno = 0;
    unsigned long long id = strtoull(line + 6, &end, 10);
    if (errno || line[6] < '0' || line[6] > '9' || !end || strcmp(end, "\n") != 0 ||
        id == 0 || id > MAX_REVISION) return 2;
    report((uint64_t)id);
  }
  /* Process exit releases the queue and every watched descriptor together. */
  return ferror(stdin) ? 2 : 0;
}
