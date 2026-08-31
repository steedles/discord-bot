# Playwright's own image, not node:alpine.
#
# The bot runs on node:alpine and must keep doing so - Playwright's browsers are
# built against glibc and do not run on musl. That incompatibility is the whole
# reason this is a separate container rather than a module inside the bot.
#
# Pin the image tag to the playwright-core version in package.json - and pin
# that dependency EXACTLY, with no caret. A caret let npm install 1.62.1 against
# this 1.49.0 image, and the mismatch surfaced as a crash-looping container
# hunting for a browser binary that was never in the image.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The image ships this user. The browser profile is a mounted volume and must be
# writable by it, so the compose file sets the same uid on the volume.
USER pwuser

# No healthcheck on purpose. "Chrome is running" is not the question - the
# question is whether events are arriving, which only the bot can judge, from
# the heartbeats this process sends it.
CMD ["node", "dist/index.js"]
