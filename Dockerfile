ARG APP_PATH=/opt/outline
ARG BASE_IMAGE=outlinewiki/outline-base
FROM ${BASE_IMAGE} AS base

ARG APP_PATH
WORKDIR $APP_PATH

# ---
FROM node:26.3.0-slim AS runner

LABEL org.opencontainers.image.source="https://github.com/outline/outline"

ARG APP_PATH
WORKDIR $APP_PATH
ENV NODE_ENV=production

# The commit this image was built from. `server/env.ts` exposes SOURCE_COMMIT to
# the client as `env.VERSION`, which the UI surfaces so an operator can confirm
# which revision is actually deployed. Left empty when the build does not supply
# it, which the environment parser reads as "no version".
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT

# Limit glibc malloc arenas, which default to 8 per CPU. Each arena can hold
# onto 64MB of virtual memory and freed allocations, which inflates resident
# memory in multi-threaded Node.js processes for no performance benefit here.
ENV MALLOC_ARENA_MAX=2

# Create a non-root user compatible with Debian and BusyBox based images
RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --ingroup nodejs nodejs && \
    mkdir -p /var/lib/outline && \
    chown -R nodejs:nodejs /var/lib/outline && \
    chown -R nodejs:nodejs $APP_PATH

COPY --from=base --chown=nodejs:nodejs $APP_PATH/build ./build
COPY --from=base --chown=nodejs:nodejs $APP_PATH/server ./server
COPY --from=base --chown=nodejs:nodejs $APP_PATH/public ./public
COPY --from=base --chown=nodejs:nodejs $APP_PATH/.sequelizerc ./.sequelizerc
COPY --from=base --chown=nodejs:nodejs $APP_PATH/node_modules ./node_modules
COPY --from=base --chown=nodejs:nodejs $APP_PATH/package.json ./package.json
# Install wget to healthcheck the server
# Install Chromium and fonts used to render PDF exports
RUN  apt-get update \
    && apt-get install -y wget chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
ENV PDF_EXPORT_CHROMIUM_PATH=/usr/bin/chromium

ENV FILE_STORAGE_LOCAL_ROOT_DIR=/var/lib/outline/data
RUN mkdir -p "$FILE_STORAGE_LOCAL_ROOT_DIR" && \
    chown -R nodejs:nodejs "$FILE_STORAGE_LOCAL_ROOT_DIR" && \
    chmod 1777 "$FILE_STORAGE_LOCAL_ROOT_DIR"

# The migrations in ./server and the Sequelize CLI in ./server/node_modules are
# both needed at runtime, not just at build time.
RUN chmod +x server/scripts/docker-entrypoint.sh

VOLUME /var/lib/outline/data

USER nodejs

HEALTHCHECK --interval=1m CMD wget -qO- "http://localhost:${PORT:-3000}/_health" | grep -q "OK" || exit 1

EXPOSE 3000
# Applies pending migrations, then runs the CMD below. Migrations are not run by
# the image build or by Watchtower. Assumes a single replica.
ENTRYPOINT ["/opt/outline/server/scripts/docker-entrypoint.sh"]
CMD ["node", "build/server/index.js"]
