#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <unistd.h>

/* Keep each visible password prompt ahead of the next terminal operation. */
ssize_t write(int fd, const void *buffer, size_t length) {
    ssize_t (*next_write)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
    ssize_t written = next_write(fd, buffer, length);
    if (memmem(buffer, length, "password:", 9)) usleep(100000);
    return written;
}
