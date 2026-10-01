// Command relay is the single Relay binary: REST API, SSE stream, MCP
// endpoint, and embedded migrations. See ARCHITECTURE.md.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Dvorinka/relay/db"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/server"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"go.uber.org/zap"
)

// version is stamped by -ldflags "-X main.version=..." at release time.
var version = "dev"

func main() {
	cfg, err := config.Load()
	if err != nil {
		fatal(nil, err)
	}

	log, err := cfg.Logger()
	if err != nil {
		fatal(nil, err)
	}
	defer log.Sync() //nolint:errcheck // best-effort flush on exit

	if err := run(cfg, log); err != nil {
		fatal(log, err)
	}
}

func run(cfg config.Config, log *zap.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := connectWithRetry(ctx, cfg.DatabaseURL, log)
	if err != nil {
		return err
	}
	defer pool.Close()

	if !cfg.SkipMigrations {
		if err := migrate(ctx, pool, log); err != nil {
			return err
		}
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.New(cfg, log, pool, version),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", zap.String("addr", cfg.ListenAddr), zap.String("version", version))
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// connectWithRetry pings until Postgres answers or the process is stopped;
// containers routinely start before Postgres accepts connections.
func connectWithRetry(ctx context.Context, databaseURL string, log *zap.Logger) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	for attempt := 1; ; attempt++ {
		if err := pool.Ping(ctx); err == nil {
			return pool, nil
		} else if attempt >= 20 {
			pool.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			pool.Close()
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
			log.Warn("postgres not ready, retrying", zap.Int("attempt", attempt))
		}
	}
}

func migrate(ctx context.Context, pool *pgxpool.Pool, log *zap.Logger) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close() //nolint:errcheck // returns the conn to the pool

	goose.SetBaseFS(db.MigrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		return err
	}
	log.Info("migrations applied")
	return nil
}

func fatal(log *zap.Logger, err error) {
	if log != nil {
		log.Fatal("fatal", zap.Error(err))
	}
	// Logger not yet initialized; stderr + exit is the honest failure path.
	os.Stderr.WriteString("fatal: " + err.Error() + "\n")
	os.Exit(1)
}
