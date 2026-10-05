# Relay task runner. `just --list` to see everything.

# start dependencies + backend + frontend in dev mode
dev:
    docker compose up -d postgres minio minio-init
    trap 'docker compose stop' INT; \
    go run ./cmd/relay & \
    npm run dev --prefix apps/web & \
    wait

# run database migrations
migrate:
    goose -dir db/migrations postgres "$DATABASE_URL" up

# create a new migration: just migration add_issues
migration name:
    goose -dir db/migrations create {{name}} sql

# regenerate sqlc code after editing db/queries
sqlc:
    sqlc generate

# regenerate the TS client after editing api/openapi.yaml
api:
    npm run api

# all tests (go + web)
test:
    go test ./...
    npm test --prefix apps/web --if-present

# db-backed e2e suite against a real postgres — creates relay_e2e once on the
# local instance, then runs the full go suite with the DSN so nothing skips.
# Needs postgres at localhost:5432 (host install, or publish the compose
# service's port). Without this recipe the suite silently skips.
e2e:
    psql "postgres://relay:relay@127.0.0.1:5432/postgres" -qc "CREATE DATABASE relay_e2e" 2>/dev/null; \
    RELAY_TEST_DATABASE_URL=postgres://relay:relay@127.0.0.1:5432/relay_e2e?sslmode=disable go test ./...

# lint + typecheck, zero warnings expected
check:
    go vet ./...
    golangci-lint run
    npx tsc --noEmit -p apps/web

# build everything
build:
    go build ./...
    npm run build --prefix apps/web

# build the production docker image
image:
    docker build -f deploy/Dockerfile -t relay:local .
