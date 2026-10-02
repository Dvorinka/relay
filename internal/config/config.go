// Package config loads Relay's environment configuration. All knobs are
// documented in .env.example.
package config

import (
	"errors"
	"os"
	"strconv"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

type Config struct {
	DatabaseURL     string
	ListenAddr      string
	PublicURL       string
	// LandingURL is the GitHub App's homepage link; defaults to PublicURL so
	// self-hosted installs point at the app itself.
	LandingURL      string
	StaticDir       string
	LogLevel        string
	AuthSecret      string
	SessionTTLHours int
	SkipMigrations  bool
	InsecureDev     bool

	StorageEndpoint       string
	StoragePublicEndpoint string
	StorageRegion         string
	StorageAccessKey      string
	StorageSecretKey      string
	StorageBucket         string
	StorageMaxUploadMiB   int64
	StoragePresignTTL     int
	// GITHUB_TOKEN is a dev fallback so the development panel works without a
	// registered GitHub App. Installation tokens take precedence once an app exists.
	GitHubToken string
}

func Load() (Config, error) {
	cfg := Config{
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		ListenAddr:      getEnv("RELAY_LISTEN_ADDR", ":8080"),
		PublicURL:       getEnv("RELAY_PUBLIC_URL", "http://localhost:8080"),
		LandingURL:      getEnv("RELAY_LANDING_URL", ""),
		StaticDir:       getEnv("RELAY_STATIC_DIR", "public"),
		LogLevel:        getEnv("LOG_LEVEL", "info"),
		AuthSecret:      os.Getenv("AUTH_SECRET"),
		SessionTTLHours: getInt("AUTH_SESSION_TTL_HOURS", 720), // 30 days
		SkipMigrations:  getBool("RELAY_SKIP_MIGRATIONS"),
		InsecureDev:     getBool("AUTH_INSECURE_DEV"),

		StorageEndpoint:       os.Getenv("STORAGE_ENDPOINT"),
		StoragePublicEndpoint: os.Getenv("STORAGE_PUBLIC_ENDPOINT"),
		StorageRegion:         getEnv("STORAGE_REGION", "us-east-1"),
		StorageAccessKey:      os.Getenv("STORAGE_ACCESS_KEY"),
		StorageSecretKey:      os.Getenv("STORAGE_SECRET_KEY"),
		StorageBucket:         getEnv("STORAGE_BUCKET", "relay"),
		StorageMaxUploadMiB:   int64(getInt("STORAGE_MAX_UPLOAD_MIB", 25)),
		StoragePresignTTL:     getInt("STORAGE_PRESIGN_TTL", 300),
		GitHubToken:           os.Getenv("GITHUB_TOKEN"),
	}

	var missing []string
	if cfg.DatabaseURL == "" {
		missing = append(missing, "DATABASE_URL")
	}
	if cfg.AuthSecret == "" {
		missing = append(missing, "AUTH_SECRET")
	}
	if len(missing) > 0 {
		return cfg, errors.New("missing required env vars: " + joinComma(missing))
	}
	return cfg, nil
}

func (c Config) Logger() (*zap.Logger, error) {
	var zl zapcore.Level
	if err := zl.UnmarshalText([]byte(c.LogLevel)); err != nil {
		zl = zapcore.InfoLevel
	}
	cfg := zap.NewProductionConfig()
	cfg.Level = zap.NewAtomicLevelAt(zl)
	if c.InsecureDev {
		cfg = zap.NewDevelopmentConfig()
		cfg.Level = zap.NewAtomicLevelAt(zl)
		cfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	}
	return cfg.Build()
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getBool(key string) bool {
	v, _ := strconv.ParseBool(os.Getenv(key))
	return v
}

func getInt(key string, fallback int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return v
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}
