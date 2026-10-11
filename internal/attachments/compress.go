package attachments

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"

	"golang.org/x/image/draw"
)

// limitedLongEdge caps raster uploads on RELAY_LIMITED instances — the free
// tier's images get one bounded re-encode instead of storing raw originals.
const limitedLongEdge = 1600

// CompressImage bounds a raster upload for the limited tier: jpeg/png are
// downscaled to limitedLongEdge on the long edge and re-encoded (JPEG q75
// for opaque images, PNG to keep alpha). Other types, tiny images and
// undecodable payloads pass through untouched. Returns (bytes, contentType,
// changed) — callers keep the original when changed is false.
func CompressImage(data []byte, contentType string) ([]byte, string, bool) {
	if contentType != "image/jpeg" && contentType != "image/png" {
		return data, contentType, false
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data, contentType, false
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return data, contentType, false
	}
	// Alpha is decided on the decoded source: the downscale target is RGBA,
	// which always reads as alpha-capable by type.
	noAlpha := opaque(src)
	long := max(w, h)
	if long <= limitedLongEdge && contentType == "image/jpeg" {
		// Small opaque jpeg — already cheap; skip a re-encode that could
		// only grow it.
		return data, contentType, false
	}
	if long > limitedLongEdge {
		scale := float64(limitedLongEdge) / float64(long)
		dw, dh := max(1, int(float64(w)*scale+0.5)), max(1, int(float64(h)*scale+0.5))
		dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
		src = dst
	}
	if noAlpha {
		var out bytes.Buffer
		if err := jpeg.Encode(&out, src, &jpeg.Options{Quality: 75}); err == nil {
			return out.Bytes(), "image/jpeg", true
		}
		return data, contentType, false
	}
	var out bytes.Buffer
	if err := png.Encode(&out, src); err == nil {
		return out.Bytes(), "image/png", true
	}
	return data, contentType, false
}

// opaque reports whether the image can carry alpha. Decoders hand back
// alpha-capable concrete types only when the source has an alpha channel —
// a type switch beats pixel sampling, which can miss thin transparency.
func opaque(img image.Image) bool {
	switch img.(type) {
	case *image.NRGBA, *image.NRGBA64, *image.Alpha, *image.Alpha16, *image.Paletted:
		return false
	}
	return true
}
