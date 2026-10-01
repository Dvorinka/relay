// Package db embeds the goose migrations so a single relay binary can
// upgrade any database it points at.
package db

import "embed"

//go:embed migrations/*.sql
var MigrationsFS embed.FS
