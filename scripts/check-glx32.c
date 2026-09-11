/* A 32-bit GLX client: create a direct context and identify its renderer. */
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    void *x11 = dlopen("libX11.so.6", RTLD_NOW);
    void *gl = dlopen("libGL.so.1", RTLD_NOW);
    if (!x11 || !gl) { fprintf(stderr, "%s\n", dlerror()); return 1; }
    void *(*open_display)(const char *) = dlsym(x11, "XOpenDisplay");
    void **(*choose_config)(void *, int, const int *, int *) = dlsym(gl, "glXChooseFBConfig");
    unsigned long (*create_pbuffer)(void *, void *, const int *) = dlsym(gl, "glXCreatePbuffer");
    void *(*create_context)(void *, void *, int, void *, int) = dlsym(gl, "glXCreateNewContext");
    int (*make_current)(void *, unsigned long, unsigned long, void *) = dlsym(gl, "glXMakeContextCurrent");
    int (*is_direct)(void *, void *) = dlsym(gl, "glXIsDirect");
    const unsigned char *(*get_string)(unsigned) = dlsym(gl, "glGetString");
    if (!open_display || !choose_config || !create_pbuffer || !create_context || !make_current || !is_direct || !get_string) return 1;
    void *display = open_display(NULL);
    if (!display) { fputs("Cannot open X display\n", stderr); return 1; }
    int attributes[] = {0x8010, 4, 0x8011, 1, 0}; /* Pbuffer, RGBA */
    int count = 0;
    void **configs = choose_config(display, 0, attributes, &count);
    if (!configs || count == 0) return 1;
    int size[] = {0x8041, 16, 0x8040, 16, 0};
    unsigned long buffer = create_pbuffer(display, configs[0], size);
    void *context = create_context(display, configs[0], 0x8014, NULL, 1);
    if (!context || !buffer || !is_direct(display, context) || !make_current(display, buffer, buffer, context)) return 1;
    const char *renderer = (const char *)get_string(0x1f01); /* GL_RENDERER */
    if (!renderer) return 1;
    printf("32-bit direct GLX renderer: %s\n", renderer);
    return sizeof(void *) != 4 || strstr(renderer, "NVIDIA") == NULL;
}
