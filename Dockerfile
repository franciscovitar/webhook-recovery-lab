FROM node:24-alpine AS build
WORKDIR /app
COPY --chmod=644 package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chmod=644 package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN chmod -R a+rX ./migrations
USER node
CMD ["node", "dist/bin/api.js"]
