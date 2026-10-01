package auth

import "testing"

func TestPasswordRoundTrip(t *testing.T) {
	hash, err := hashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	ok, err := verifyPassword("correct horse battery staple", hash)
	if err != nil || !ok {
		t.Fatalf("valid password rejected: ok=%v err=%v", ok, err)
	}
	ok, err = verifyPassword("wrong horse", hash)
	if err != nil || ok {
		t.Fatalf("invalid password accepted: ok=%v err=%v", ok, err)
	}
}

func TestTokenHashStable(t *testing.T) {
	raw, hash, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	if hashToken(raw) != hash {
		t.Fatal("hashToken must reproduce newToken's hash")
	}
	if raw2, _, _ := newToken(); raw2 == raw {
		t.Fatal("token collision")
	}
}

func TestSlugify(t *testing.T) {
	for in, want := range map[string]string{
		"My Cool App":  "my-cool-app",
		"  Spaces!! ":  "spaces",
		"":             "ws",
		"Ünïcodé":      "n-cod", // non-ascii letters drop out
		"a":            "ws",
		"-already-ok-": "already-ok",
	} {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}
