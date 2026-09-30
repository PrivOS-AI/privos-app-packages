FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
# The port is the manifest's `port`; keep the three in step.
ENV NODE_ENV=production PORT=3001
WORKDIR /app
# Patch the base image's packages, and leave no package manager in the runtime image.
RUN apk --no-cache upgrade \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/privos-app.json ./privos-app.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist-server/server.js"]
