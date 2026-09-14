# syntax=docker/dockerfile:1.7

# ---- 构建阶段：在构建机本地架构上交叉编译，避免 QEMU 模拟编译 ----
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
WORKDIR /src

COPY api/go.mod api/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY api/ ./

ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/werun ./cmd/werun

# 文件目录预先建好，属主为 distroless nonroot（65532）
RUN mkdir -p /out/data/files/public

# ---- 运行阶段 ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/werun /werun
COPY --from=build --chown=65532:65532 /out/data /data
ENV WERUN_HTTP_ADDR=:8080 \
    WERUN_FILES_DIR=/data/files
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/werun"]
CMD ["serve", "--with-worker"]
