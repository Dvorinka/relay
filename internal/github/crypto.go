package github

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"time"

	"github.com/Dvorinka/relay/internal/secrets"
)

// seal/open delegate to the shared secrets package — AUTH_SECRET-keyed
// AES-256-GCM at rest.
func seal(plain []byte, secret string) ([]byte, error) {
	return secrets.Seal(plain, secret)
}

func open(sealed []byte, secret string) ([]byte, error) {
	return secrets.Open(sealed, secret)
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
