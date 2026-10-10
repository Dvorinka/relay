package unfurl

import (
	"net/netip"
	"net/url"
	"testing"
)

func TestForbidden(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1",
		"169.254.169.254", "0.0.0.0", "::1", "fe80::1",
		"224.0.0.1", "ff02::1", "100.64.0.1", "192.0.0.1",
		"::ffff:10.0.0.1", "::ffff:127.0.0.1", "2001:db8::1",
		"198.51.100.7", "198.18.0.2",
	}
	for _, s := range blocked {
		if !forbidden(netip.MustParseAddr(s)) {
			t.Errorf("expected %s blocked", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"}
	for _, s := range allowed {
		if forbidden(netip.MustParseAddr(s)) {
			t.Errorf("expected %s allowed", s)
		}
	}
}

func TestValidTarget(t *testing.T) {
	bad := []string{
		"ftp://example.com", "file:///etc/passwd", "gopher://x",
		"http://user:pass@example.com/", "http://",
	}
	for _, s := range bad {
		if u, _ := url.Parse(s); validTarget(u) == nil {
			t.Errorf("expected %s rejected", s)
		}
	}
	for _, s := range []string{"http://example.com", "https://a.b/c?d=e"} {
		if u, _ := url.Parse(s); validTarget(u) != nil {
			t.Errorf("expected %s accepted", s)
		}
	}
}
