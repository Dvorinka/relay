package attachments

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func bigPNG(t *testing.T, alpha bool) []byte {
	t.Helper()
	w, h := 3200, 2400
	var img image.Image
	if alpha {
		rgba := image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y += 40 {
			for x := 0; x < w; x++ {
				rgba.SetNRGBA(x, y, color.NRGBA{A: 0x80, R: 0xff})
			}
		}
		img = rgba
	} else {
		rgb := image.NewRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				rgb.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 0x40, A: 0xff})
			}
		}
		img = rgb
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestCompressImageDownscalesAndReencodes(t *testing.T) {
	out, ct, changed := CompressImage(bigPNG(t, false), "image/png")
	if !changed {
		t.Fatal("expected a re-encode")
	}
	if ct != "image/jpeg" {
		t.Fatalf("opaque image should become jpeg, got %s", ct)
	}
	img, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != limitedLongEdge {
		t.Fatalf("long edge = %d, want %d", img.Bounds().Dx(), limitedLongEdge)
	}
}

func TestCompressImageKeepsAlphaPNG(t *testing.T) {
	out, ct, changed := CompressImage(bigPNG(t, true), "image/png")
	if !changed {
		t.Fatal("expected a re-encode")
	}
	if ct != "image/png" {
		t.Fatalf("alpha image must stay png, got %s", ct)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != limitedLongEdge {
		t.Fatalf("long edge = %d, want %d", img.Bounds().Dx(), limitedLongEdge)
	}
}

func TestCompressImagePassesOtherTypesThrough(t *testing.T) {
	in := []byte("%PDF-1.4 fake")
	out, ct, changed := CompressImage(in, "application/pdf")
	if changed || ct != "application/pdf" || !bytes.Equal(out, in) {
		t.Fatalf("non-image should pass through untouched")
	}
}
