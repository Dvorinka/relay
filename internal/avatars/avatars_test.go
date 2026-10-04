package avatars

import (
	"context"
	"net"
	"strings"
	"testing"
)

func TestAcceptedImageType(t *testing.T) {
	png := append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, make([]byte, 32)...)
	ftyp := func(brand string) []byte {
		d := make([]byte, 32)
		copy(d[4:8], "ftyp")
		copy(d[8:12], brand)
		return d
	}
	for _, tc := range []struct {
		name string
		data []byte
		want bool
	}{
		{"png", png, true},
		{"avif", ftyp("avif"), true},
		{"avif sequence", ftyp("avis"), true},
		{"bmp", append([]byte("BM"), make([]byte, 32)...), true},
		{"ico", append([]byte{0, 0, 1, 0}, make([]byte, 32)...), true},
		{"heic rejected", ftyp("heic"), false},
		{"svg rejected", []byte(`<?xml version="1.0"?><svg/>`), false},
		{"empty", []byte{}, false},
		{"text", []byte("not an image"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, got := AcceptedImageType(tc.data)
			if got != tc.want {
				t.Fatalf("AcceptedImageType(%s) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

func TestPublicIP(t *testing.T) {
	for _, tc := range []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"1.1.1.1", true},
		{"2606:4700:4700::1111", true},
		{"127.0.0.1", false},
		{"10.0.0.4", false},
		{"192.168.1.10", false},
		{"172.16.0.1", false},
		{"169.254.169.254", false}, // cloud metadata
		{"0.0.0.0", false},
		{"::1", false},
		{"fe80::1", false},
		{"224.0.0.1", false},
	} {
		t.Run(tc.ip, func(t *testing.T) {
			if got := publicIP(net.ParseIP(tc.ip)); got != tc.want {
				t.Fatalf("publicIP(%s) = %v, want %v", tc.ip, got, tc.want)
			}
		})
	}
}

func TestFetchImageRejectsLocal(t *testing.T) {
	// Scheme checks and private-range dials must all fail — these need no
	// network since they never get that far.
	for _, u := range []string{
		"ftp://example.com/x.png",
		"javascript:alert(1)",
		"http://127.0.0.1:8080/internal.png",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]:8080/x.png",
		"not-a-url",
	} {
		t.Run(u, func(t *testing.T) {
			_, _, err := FetchImage(context.Background(), u)
			if err == nil {
				t.Fatalf("FetchImage(%s) should fail", u)
			}
			if strings.Contains(u, "127.0.0.1") || strings.Contains(u, "169.254") || strings.Contains(u, "::1") {
				if !strings.Contains(err.Error(), "public address") {
					t.Fatalf("FetchImage(%s) = %v, want a public-address rejection", u, err)
				}
			}
		})
	}
}
