FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates gosu netbase nfs-common smbclient \
    && rm -rf /var/lib/apt/lists/*

ARG COMPANION_REPO_URL=https://github.com/ignacio82/SpatialFin-Companion.git
ENV COMPANION_REPO_URL=${COMPANION_REPO_URL}

# Clone the public repo and check out the latest release tag (if any) so the
# container ships with the newest released code and a valid .git directory for
# entrypoint.sh to pull future updates into. Falls back to master when no
# release tag exists yet.
RUN git clone "$COMPANION_REPO_URL" /app \
    && latest_tag=$(git -C /app tag --list --sort=-v:refname 'v*' | head -n 1) \
    && if [ -n "$latest_tag" ]; then \
         git -C /app -c advice.detachedHead=false checkout "$latest_tag"; \
       fi \
    && npm ci --omit=dev \
    && chmod +x /app/entrypoint.sh

EXPOSE 1982

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:1982/api/admin/auth-check', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["/app/entrypoint.sh"]
