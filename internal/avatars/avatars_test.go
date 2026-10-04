package avatars

import "testing"

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
