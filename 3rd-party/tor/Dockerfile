FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

LABEL maintainer="Peter Dave Hello <hsu@peterdavehello.org>"
LABEL name="tor-socks"
LABEL version="latest"

RUN echo '@edge http://dl-cdn.alpinelinux.org/alpine/edge/community' >> /etc/apk/repositories && \
    apk -U upgrade && \
    apk -v add tor@edge curl && \
    chmod 700 /var/lib/tor && \
    rm -rf /var/cache/apk/* && \
    tor --version
COPY torrc /etc/tor/

HEALTHCHECK --timeout=10s --start-period=60s \
    CMD curl --fail --socks5-hostname localhost:9050 -I -L 'https://cdnjs.com/' || exit 1

EXPOSE 9050

CMD ["/usr/bin/tor", "-f", "/etc/tor/torrc"]
