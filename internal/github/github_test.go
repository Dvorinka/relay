package github

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func sig(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestValidSignature(t *testing.T) {
	secret := []byte("hook-secret")
	body := []byte(`{"action":"opened"}`)
	if !validSignature(secret, body, sig(secret, body)) {
		t.Fatal("expected valid signature to pass")
	}
	if validSignature(secret, body, sig([]byte("wrong"), body)) {
		t.Fatal("wrong secret must fail")
	}
	if validSignature(secret, append(body, ' '), sig(secret, body)) {
		t.Fatal("tampered body must fail")
	}
	if validSignature(secret, body, "sha256=zz") {
		t.Fatal("garbage header must fail")
	}
	if validSignature(secret, body, "") {
		t.Fatal("missing header must fail")
	}
}

func TestAppJWT(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(priv),
	})
	tok, err := appJWT(424242, pemKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt must have 3 parts, got %d", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		Iss string `json:"iss"`
		Iat int64  `json:"iat"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Iss != "424242" {
		t.Fatalf("iss = %q", claims.Iss)
	}
	if claims.Exp <= claims.Iat {
		t.Fatal("exp must be after iat")
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&priv.PublicKey, crypto.SHA256, sum[:], sigBytes); err != nil {
		t.Fatalf("jwt signature invalid: %v", err)
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	secret := strings.Repeat("k", 32)
	enc, err := seal([]byte("private-key-material"), secret)
	if err != nil {
		t.Fatal(err)
	}
	out, err := open(enc, secret)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "private-key-material" {
		t.Fatalf("roundtrip mismatch: %q", out)
	}
	if _, err := open(enc, strings.Repeat("x", 32)); err == nil {
		t.Fatal("wrong key must fail")
	}
}

func TestManifestPage(t *testing.T) {
	s := &Service{}
	render := func(t *testing.T, query string) (int, string, string) {
		t.Helper()
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/github/manifest-page?"+query, nil)
		s.handleManifestPage(c)
		return w.Code, w.Body.String(), w.Header().Get("Content-Security-Policy")
	}

	manifest := `{"name":"Relay","url":"https://x/cb","hook_attributes":{"url":"https://x/h"},"redirect_url":"https://x/d","public":false,"default_events":["issues"],"default_permissions":{"issues":"write"}}`
	enc := base64.RawURLEncoding.EncodeToString([]byte(manifest))

	t.Run("valid payload renders auto-submit form", func(t *testing.T) {
		code, body, csp := render(t, "m="+enc)
		if code != http.StatusOK {
			t.Fatalf("got %d", code)
		}
		for _, want := range []string{
			`method="post" action="https://github.com/settings/apps/new"`,
			`name="manifest"`,
			`&#34;default_permissions&#34;`, // JSON stays html-escaped in the hidden field
			`document.getElementById('f').submit()`,
		} {
			if !strings.Contains(body, want) {
				t.Errorf("missing %q", want)
			}
		}
		if !strings.Contains(csp, "script-src 'unsafe-inline'") {
			t.Errorf("CSP must allow the inline auto-submit: %q", csp)
		}
	})

	t.Run("rejects malformed payloads", func(t *testing.T) {
		for _, q := range []string{"", "m=", "m=!!!", "m=" + base64.RawURLEncoding.EncodeToString([]byte("not json")), "m=" + base64.RawURLEncoding.EncodeToString(make([]byte, 65<<10))} {
			if code, _, _ := render(t, q); code != http.StatusBadRequest {
				t.Errorf("query %q…: got %d, want 400", q[:24], code)
			}
		}
	})
}
