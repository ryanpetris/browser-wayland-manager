ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG DISTRIBUTION
COPY setup-${DISTRIBUTION}.sh /tmp/innkeeper-setup.sh
RUN sh /tmp/innkeeper-setup.sh && rm /tmp/innkeeper-setup.sh
RUN if [ "$DISTRIBUTION" = arch ]; then pacman -S --noconfirm --needed lib32-libglvnd; fi
ENV INNKEEPER_BASE_READY=1
