# syntax=docker/dockerfile:1.7

# ---- 构建阶段：两个前端的静态产物与 CPU 架构无关，固定在构建机本地架构上构建 ----
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable

# 先只复制清单文件，依赖安装层可以被缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tokens/package.json packages/tokens/
COPY packages/i18n/package.json packages/i18n/
COPY packages/api-client/package.json packages/api-client/
COPY web/user/package.json web/user/
COPY web/admin/package.json web/admin/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY tsconfig.base.json ./
COPY packages ./packages
COPY web ./web
RUN pnpm --filter @werun/user --filter @werun/admin run build

# ---- 运行阶段 ----
FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/user/dist /srv/user
COPY --from=build /repo/web/admin/dist /srv/admin
