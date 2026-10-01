package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// newToken returns (raw, hash): raw goes in the cookie/email, only the
// SHA-256 hash is persisted. Hashing means a leaked sessions table does not
// leak usable tokens.
func newToken() (raw, hash string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", err
	}
	raw = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(raw))
	return raw, hex.EncodeToString(sum[:]), nil
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
