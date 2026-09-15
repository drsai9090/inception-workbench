FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
COPY samples ./samples
COPY index.html ./index.html
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 LOCAL_DEMO=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY migrations ./migrations
USER node
EXPOSE 4318
CMD ["node", "src/server.ts"]
