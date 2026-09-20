# Linux base -- sidesteps @lancedb/lancedb dropping native darwin-x64 binaries
# after 0.22.3. @lancedb/lancedb-linux-x64-gnu is fully published and current,
# so building/running this image on Docker Desktop's Linux VM resolves it
# correctly even though the host iMac is Intel macOS.
FROM node:22-slim

# WORKDIR is /app/node, not /app, so PROJECT_ROOT (config.js: two levels above
# node/src/) resolves to /app -- matching the real repo shape (node/ as a
# subfolder of the project root) that every PROJECT_ROOT-relative path in this
# codebase (node/public, node/logs, node/uploads, data/lancedb, ...) assumes.
WORKDIR /app/node

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8100

CMD ["node", "src/server.js"]
