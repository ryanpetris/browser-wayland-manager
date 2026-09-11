#!/bin/sh
set -eu
. /opt/innkeeper/gpu-settings.sh
: > /opt/innkeeper/gpu-env.sh
if [ "$INNKEEPER_GPU_DRIVER" = nvidia ]; then
    if [ ! -c /dev/nvidiactl ] || [ ! -c /dev/nvidia-modeset ]; then
        echo 'NVIDIA control or modeset device is missing. Check Container Toolkit device injection and run nvidia-modprobe -m on the host.' >&2
        exit 1
    fi
    if ! ldconfig -p | grep -q 'libGLX_nvidia.so.0 (libc6)'; then
        echo 'NVIDIA 32-bit GLX is not visible to the session dynamic loader. Steam needs container 32-bit library support, matching host drivers and Container Toolkit compat32 injection.' >&2
    fi
    backend=
    for directory in /usr/lib/gbm /usr/lib64/gbm /usr/lib/x86_64-linux-gnu/gbm; do
        if [ -r "$directory/nvidia-drm_gbm.so" ]; then
            backend=$directory
            break
        fi
    done
    # The runtime can relocate the allocator while retaining the host's relative
    # GBM link. Use a private link without changing the injected driver files.
    if [ -z "$backend" ]; then
        allocator=$(ldconfig -p | awk '$1 == "libnvidia-allocator.so.1" && /x86-64/ {print $NF; exit}')
        if [ -n "$allocator" ] && [ -r "$allocator" ]; then
            backend=/opt/innkeeper/gbm
            mkdir -p "$backend"
            ln -sf "$allocator" "$backend/nvidia-drm_gbm.so"
        fi
    fi
    if [ -z "$backend" ]; then
        echo 'NVIDIA GBM backend is missing. Check Container Toolkit graphics injection and the host driver.' >&2
        exit 1
    fi
    for directory in /usr/lib/gbm /usr/lib64/gbm /usr/lib/x86_64-linux-gnu/gbm /usr/lib32/gbm /usr/lib/i386-linux-gnu/gbm; do
        if [ "$directory" != "$backend" ] && [ -r "$directory/dri_gbm.so" ]; then
            backend="$backend:$directory"
        fi
    done
    printf "export GBM_BACKENDS_PATH='%s'\n" "$backend" > /opt/innkeeper/gpu-env.sh
fi
chmod 644 /opt/innkeeper/gpu-env.sh
install -m 755 /opt/innkeeper/Xwayland /usr/local/bin/Xwayland
