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
	DatabaseURL string
	ListenAddr  string
	PublicURL   string
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

	// Web Push: empty keys -> auto-generated ephemeral pair (dev mode,
	// subscriptions die on restart). Set both for stable delivery.
	VapidPublic         string
	VapidPrivate        string
	VapidSubject        string
	StorageMaxUploadMiB int64
	StoragePresignTTL   int
	// GITHUB_TOKEN is a dev fallback so the development panel works without a
	// registered GitHub App. Installation tokens take precedence once an app exists.
	GitHubToken string

	// Transactional mail: Resend for the hosted tier, SMTP for self-hosters,
	// log mailer when neither is set.
	ResendAPIKey string
	ResendFrom   string
	SMTPHost     string
	SMTPPort     string
	SMTPUser     string
	SMTPPass     string
	SMTPFrom     string

	// RELAY_LIMITED marks a capacity-capped hosted instance (the free tier):
	// tighter upload cap and image re-encoding on upload. Surfaced to clients
	// via /api/health so the app can show the "limited" notice.
	Limited          bool
	LimitedUploadMiB int64
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

		VapidPublic:         os.Getenv("RELAY_VAPID_PUBLIC_KEY"),
		VapidPrivate:        os.Getenv("RELAY_VAPID_PRIVATE_KEY"),
		VapidSubject:        getEnv("RELAY_VAPID_SUBJECT", "mailto:admin@localhost"),
		StorageMaxUploadMiB: int64(getInt("STORAGE_MAX_UPLOAD_MIB", 25)),
		StoragePresignTTL:   getInt("STORAGE_PRESIGN_TTL", 300),
		GitHubToken:         os.Getenv("GITHUB_TOKEN"),

		ResendAPIKey: os.Getenv("RESEND_API_KEY"),
		ResendFrom:   getEnv("RESEND_FROM", "Relay <onboarding@resend.dev>"),
		SMTPHost:     os.Getenv("SMTP_HOST"),
		SMTPPort:     getEnv("SMTP_PORT", "587"),
		SMTPUser:     os.Getenv("SMTP_USER"),
		SMTPPass:     os.Getenv("SMTP_PASS"),
		SMTPFrom:     getEnv("SMTP_FROM", "relay@example.com"),

		Limited:          getBool("RELAY_LIMITED"),
		LimitedUploadMiB: int64(getInt("RELAY_LIMITED_UPLOAD_MIB", 8)),
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

// EffectiveUploadMiB is the cap upload handlers enforce: the limited tier's
// tighter cap when it beats the storage one.
func (c Config) EffectiveUploadMiB() int64 {
	if c.Limited && c.LimitedUploadMiB < c.StorageMaxUploadMiB {
		return c.LimitedUploadMiB
	}
	return c.StorageMaxUploadMiB
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
