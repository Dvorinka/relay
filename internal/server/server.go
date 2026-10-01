// Package server wires the Gin router: REST under /api, the SPA static
// bundle, and (in later phases) SSE and MCP endpoints.
package server

import (
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/conversations"
	"github.com/Dvorinka/relay/internal/projects"
	"github.com/Dvorinka/relay/internal/workspaces"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

func New(cfg config.Config, log *zap.Logger, pool *pgxpool.Pool, version string) http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), accessLog(log))

	authSvc := auth.NewService(cfg, log, pool, auth.NewLogMailer(log))
	wsSvc := workspaces.NewService(log, pool)
	projSvc := projects.NewService(log, pool)
	convSvc := conversations.NewService(log, pool)

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

	mountStatic(r, cfg.StaticDir)
	return r
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
