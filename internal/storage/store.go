// Package storage wraps S3-compatible object storage (RustFS in dev, any
// S3 endpoint in production). Two clients are kept: uploads go through the
// internal endpoint, presigned download URLs are minted against the public
// one so the host header is reachable from a browser.
package storage

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Store struct {
	put     *minio.Client
	pub     *minio.Client
	bucket  string
	presign time.Duration
}

// New returns nil when STORAGE_ENDPOINT is unset - callers treat a nil
// Store as "attachments disabled" and answer 503.
func New(endpoint, publicEndpoint, region, accessKey, secretKey, bucket string, presignTTL int) (*Store, error) {
	if endpoint == "" {
		return nil, nil
	}
	put, err := client(endpoint, region, accessKey, secretKey)
	if err != nil {
		return nil, fmt.Errorf("storage endpoint: %w", err)
	}
	pub := put
	if publicEndpoint != "" && publicEndpoint != endpoint {
		pub, err = client(publicEndpoint, region, accessKey, secretKey)
		if err != nil {
			return nil, fmt.Errorf("storage public endpoint: %w", err)
		}
	}
	return &Store{put: put, pub: pub, bucket: bucket, presign: time.Duration(presignTTL) * time.Second}, nil
}

func client(endpoint, region, ak, sk string) (*minio.Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	host := u.Host
	if host == "" {
		host = u.Path // bare host:port without scheme
	}
	return minio.New(host, &minio.Options{
		Creds:  credentials.NewStaticV4(ak, sk, ""),
		Secure: u.Scheme == "https",
		Region: region,
	})
}

// EnsureBucket creates the bucket when missing. Idempotent; harmless when
// the deploy provisioned it already.
func (s *Store) EnsureBucket(ctx context.Context) error {
	exists, err := s.put.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return s.put.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{})
}

func (s *Store) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.put.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

func (s *Store) Remove(ctx context.Context, key string) error {
	return s.put.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

// Get fetches an object for streaming through the API. Used when the
// browser cannot reach the public endpoint directly (LAN dev, private
// network access rules).
func (s *Store) Get(ctx context.Context, key string) (*minio.Object, error) {
	return s.put.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
}

// InlineSafe reports whether a stored file may be served inline. Only
// inert raster images qualify — SVG is excluded since it can carry script.
// Everything else downloads with attachment disposition.
func InlineSafe(contentType string) bool {
	return strings.HasPrefix(contentType, "image/") && contentType != "image/svg+xml"
}

// PresignGet mints a short-lived GET URL. Safe images are dispositioned
// inline so <img src> renders; everything else (including HTML/SVG, which
// can execute markup) downloads as an attachment.
func (s *Store) PresignGet(ctx context.Context, key, filename, contentType string) (string, error) {
	kind := "attachment"
	if InlineSafe(contentType) {
		kind = "inline"
	}
	safe := strings.NewReplacer("\\", "_", "\"", "_").Replace(filename)
	params := url.Values{}
	params.Set("response-content-disposition", kind+"; filename=\""+safe+"\"")
	u, err := s.pub.PresignedGetObject(ctx, s.bucket, key, s.presign, params)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}
