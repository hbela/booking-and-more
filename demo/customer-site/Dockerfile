# syntax=docker/dockerfile:1
#
# A fictitious customer's own website. See index.html for what it is and why.
#
# NOT product code. Deliberately absent from docker-compose.coolify.yml: this is
# a separate Coolify resource on its own domain, so it cannot be confused with
# the product stack, and cannot take it down.
#
# The build context is THIS directory, not the repository root — which is why
# the root .dockerignore's `demo` entry cannot break this build. Docker reads
# .dockerignore from the root of the context, and there is none here.
#
#   docker build -t bam-demo-customer-site demo/customer-site
#
# `wget` comes from busybox in the alpine image, and the stock image already
# serves /usr/share/nginx/html on port 80 — so there is no nginx.conf to keep.

FROM nginx:1.31-alpine

COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
