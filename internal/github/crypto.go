package github

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"time"
)

// sealedLen = nonce + ciphertext + tag overhead for a sanity check on decrypt.
func key(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// seal encrypts with AES-256-GCM under a key derived from AUTH_SECRET.
func seal(plain []byte, secret string) ([]byte, error) {
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

func open(sealed []byte, secret string) ([]byte, error) {
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

var b64 = base64.RawURLEncoding

// appJWT mints a short-lived RS256 JWT for GitHub App authentication.
func appJWT(appID int64, pemKey []byte, now time.Time) (string, error) {
	block, _ := pem.Decode(pemKey)
	if block == nil {
		return "", errors.New("invalid PEM private key")
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		var k8 any
		if k8, err = x509.ParsePKCS8PrivateKey(block.Bytes); err != nil {
			return "", fmt.Errorf("parse private key: %w", err)
		}
		var ok bool
		key, ok = k8.(*rsa.PrivateKey)
		if !ok {
			return "", errors.New("private key is not RSA")
		}
	}
	header := b64.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims := fmt.Sprintf(`{"iat":%d,"exp":%d,"iss":"%d"}`,
		now.Add(-60*time.Second).Unix(), now.Add(9*time.Minute).Unix(), appID)
	payload := header + "." + b64.EncodeToString([]byte(claims))
	sum := sha256.Sum256([]byte(payload))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return payload + "." + b64.EncodeToString(sig), nil
}
