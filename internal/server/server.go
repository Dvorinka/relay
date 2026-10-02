// Package server wires the Gin router: REST under /api, the SPA static
// bundle, and (in later phases) SSE and MCP endpoints.
package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/Dvorinka/relay/internal/agents"
	"github.com/Dvorinka/relay/internal/attachments"
	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/avatars"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/events"
	"github.com/Dvorinka/relay/internal/github"
	"github.com/Dvorinka/relay/internal/issues"
	"github.com/Dvorinka/relay/internal/mcpserver"
	"github.com/Dvorinka/relay/internal/projects"
	"github.com/Dvorinka/relay/internal/realtime"
	"github.com/Dvorinka/relay/internal/reviews"
	"github.com/Dvorinka/relay/internal/search"
	"github.com/Dvorinka/relay/internal/storage"
	"github.com/Dvorinka/relay/internal/todos"
	"github.com/Dvorinka/relay/internal/workspaces"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

func New(cfg config.Config, log *zap.Logger, pool *pgxpool.Pool, version string) http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), securityHeaders(), accessLog(log))

	store, err := storage.New(cfg.StorageEndpoint, cfg.StoragePublicEndpoint, cfg.StorageRegion,
		cfg.StorageAccessKey, cfg.StorageSecretKey, cfg.StorageBucket, cfg.StoragePresignTTL)
	if err != nil {
		// attachments degrade to 503 rather than taking the API down
		log.Error("storage init failed; attachments disabled", zap.Error(err))
	}
	if store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := store.EnsureBucket(ctx); err != nil {
			log.Error("storage bucket check failed", zap.Error(err))
		}
		cancel()
	}

	authSvc := auth.NewService(cfg, log, pool, auth.NewLogMailer(log))
	wsSvc := workspaces.NewService(log, pool)
	projSvc := projects.NewService(log, pool)
	convSvc := conversations.NewService(log, pool)
	attSvc := attachments.NewService(log, pool, store, cfg)
	issueSvc := issues.NewService(log, pool)
	agentSvc := agents.NewService(log, pool)
	ghSvc := github.NewService(cfg, log, pool)
	todoSvc := todos.NewService(log, pool)
	reviewSvc := reviews.NewService(log, pool)
	avSvc := avatars.NewService(log, pool, store)
	hub := events.New()
	convSvc.Bus = hub
	issueSvc.Bus = hub
	todoSvc.Bus = hub
	reviewSvc.Bus = hub
	rtSvc := realtime.NewService(hub, pool)
	searchSvc := search.NewService(pool)
	mcpHandler := mcpserver.New(db.New(pool), store, log, ghSvc, hub)

	api := r.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		if err := pool.Ping(c.Request.Context()); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": gin.H{"code": "db_unreachable", "message": "postgres ping failed"},
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok", "version": version})
	})

	authSvc.RegisterRoutes(api)
	priv := api.Group("", authSvc.RequireAuth)
	wsSvc.RegisterRoutes(priv)
	projSvc.RegisterRoutes(priv)
	convSvc.RegisterRoutes(priv)
	attSvc.RegisterRoutes(priv)
	issueSvc.RegisterRoutes(priv)
	agentSvc.RegisterRoutes(priv)
	ghSvc.RegisterRoutes(priv, api)
	todoSvc.RegisterRoutes(priv)
	reviewSvc.RegisterRoutes(priv)
	avSvc.RegisterRoutes(priv)
	rtSvc.RegisterRoutes(priv)
	searchSvc.RegisterRoutes(priv)

	// external agents: bearer-token MCP, not session cookies
	r.POST("/mcp", mcpHandler)

	mountStatic(r, cfg.StaticDir)
	return r
}

// securityHeaders sets baseline headers on every response. img-src allows
// https: so presigned storage URLs on any host render; style-src keeps
// 'unsafe-inline' because UI libs set element styles directly.
func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; "+
				"object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		c.Next()
	}
}

// mountStatic serves the built SPA from dir when it exists; API routes win,
// everything else falls back to index.html for client-side routing.
func mountStatic(r *gin.Engine, dir string) {
	index := filepath.Join(dir, "index.html")
	if _, err := os.Stat(index); err != nil {
		return // no bundle (dev mode serves the SPA via Vite)
	}
	r.Static("/assets", filepath.Join(dir, "assets"))
	r.StaticFile("/favicon.svg", filepath.Join(dir, "favicon.svg"))
	r.NoRoute(func(c *gin.Context) {
		c.File(index)
	})
}

func accessLog(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.Info("http",
			zap.String("method", c.Request.Method),
			zap.String("path", c.Request.URL.Path),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("dur", time.Since(start)),
		)
	}
}
