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

# Xvfb, because Fomo's app does not boot in headless Chromium.
#
# Measured, not guessed: headless loads the marketing shell (25 characters of
# body text, the landing-page <title>), completes the websocket challenge, then
# subscribes to NOTHING and is dropped by the server - 41 reconnects in twenty
# minutes and not one event. The same profile in a headed browser boots the app
# and delivers thousands of frames.
#
# So the browser runs headed against a virtual display. `xvfb-run` is a few MB
# and removes an entire class of "works on my machine, silently does nothing in
# the container" failure.
USER root
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*
USER pwuser

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The image ships this user. The browser profile is a mounted volume and must be
# writable by it, so the compose file sets the same uid on the volume.
USER pwuser

# No healthcheck on purpose. "Chrome is running" is not the question - the
# question is whether events are arriving, which only the bot can judge, from
# the heartbeats this process sends it.
# -a picks a free display number; --server-args sizes it to match the viewport.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x900x24", "node", "dist/index.js"]
