// Package secrets provides at-rest encryption for credentials stored in
// the database — AES-256-GCM under a key derived from AUTH_SECRET.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

func key(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// Seal encrypts with AES-256-GCM under a key derived from secret.
func Seal(plain []byte, secret string) ([]byte, error) {
	block, err := aes.NewCipher(key(secret))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plain, nil), nil
}

// Open reverses Seal; the nonce rides inside the sealed value.
func Open(sealed []byte, secret string) ([]byte, error) {
	block, err := aes.NewCipher(key(secret))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("sealed value too short")
	}
	return gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
}
