// Package localfiles: safe read-only traversal of a project-linked
// directory on the server host. Shared by the REST file endpoints and the
// MCP file tools. The single rule: nothing escapes the configured root —
// relative paths are cleaned into it and symlinks must resolve inside it.
package localfiles

import (
	"os"
	"path/filepath"
	"strings"
)

// Directories never worth listing in a project tree.
var SkipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, ".next": true, ".cache": true, "target": true,
	"coverage": true, ".turbo": true, ".idea": true, ".vscode": true,
}

const MaxTreeEntries = 2000
const MaxReadBytes = 256 * 1024

// Sensitive basenames never listed or read — a linked folder is browsable
// by every workspace member and every file:read-scoped agent.
func Sensitive(name string) bool {
	switch name {
	case ".env", ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json":
		return true
	}
	if strings.HasPrefix(name, ".env.") || strings.HasPrefix(name, "id_rsa") ||
		strings.HasPrefix(name, "id_ed25519") || strings.HasPrefix(name, "id_dsa") {
		return true
	}
	switch filepath.Ext(name) {
	case ".pem", ".key", ".p12", ".pfx", ".kdbx":
		return true
	}
	return false
}

// ResolveInRoot maps a client-supplied relative path inside root; empty is
// the root itself. ok=false on escapes, broken symlinks, or missing paths.
func ResolveInRoot(root, rel string) (string, bool) {
	if root == "" {
		return "", false
	}
	clean := filepath.Clean("/" + rel) // forces absolute-within-root semantics
	full := filepath.Join(root, strings.TrimPrefix(clean, "/"))
	rp, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", false
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", false
	}
	if rp != rootReal && !strings.HasPrefix(rp, rootReal+string(os.PathSeparator)) {
		return "", false
	}
	return rp, true
}
