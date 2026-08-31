FROM node:24-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
# copy-public.mjs moves the dashboard's static files into dist/ after tsc.
COPY scripts ./scripts
RUN pnpm build

# Drop dev dependencies before copying node_modules into the runtime image.
RUN pnpm prune --prod

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Created here, not left to the volume mount. Docker seeds an empty named volume
# from the image path it covers, ownership included - without this the mount
# arrives root-owned and `USER node` cannot write its log file into it.
RUN mkdir -p /var/log/bot && chown node:node /var/log/bot

USER node

CMD ["node", "dist/index.js"]
