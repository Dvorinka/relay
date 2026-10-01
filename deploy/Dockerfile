# Multi-stage build: web assets -> Go binary -> minimal runtime.

# --- web build ---
FROM node:26-alpine AS web
WORKDIR /src
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable && npm ci || true
COPY packages/api-client packages/api-client
COPY apps/web apps/web
RUN npm run build --prefix apps/web

# --- backend build ---
FROM golang:1.24-alpine AS backend
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY db/ db/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay

# --- runtime ---
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -u 10001 relay
WORKDIR /app
COPY --from=backend /out/relay /app/relay
COPY --from=web /src/apps/web/dist /app/public
COPY db/migrations /app/db/migrations
USER relay
EXPOSE 8080
ENTRYPOINT ["/app/relay"]
