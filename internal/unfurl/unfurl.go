// Package unfurl fetches Open Graph metadata for URLs that show up in
// messages. It's a deliberate SSRF surface — the dialer rejects any
// resolved address outside global unicast space (loopback, private,
// link-local incl. 169.254.169.254, multicast), schemes are limited to
// http(s), redirects are capped and re-validated, and reads are bounded.
package unfurl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"golang.org/x/net/html"

	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
)

const (
	cacheTTL     = 7 * 24 * time.Hour
	failureTTL   = time.Hour
	maxRedirects = 3
	maxBody      = 256 << 10
	fetchTimeout = 8 * time.Second
	maxURL       = 2048
)

type Service struct {
	q   *db.Queries
	log *zap.Logger
	cli *http.Client
}

func NewService(log *zap.Logger, pool *pgxpool.Pool) *Service {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	tr := &http.Transport{
		// Every dialed address is checked — covering the original host, each
		// redirect hop, and DNS rebinding between lookup and connect.
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil {
				// hostname slipped through — resolve and validate all answers
				resolver := dialer.Resolver
				if resolver == nil {
					resolver = net.DefaultResolver
				}
				ips, rerr := resolver.LookupIP(ctx, "ip", host)
				if rerr != nil || len(ips) == 0 {
					return nil, fmt.Errorf("unfurl: cannot resolve host")
				}
				for _, rip := range ips {
					a, ok := netip.AddrFromSlice(rip)
					if !ok || forbidden(a) {
						return nil, fmt.Errorf("unfurl: private/reserved address")
					}
				}
				return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
			}
			if forbidden(ip) {
				return nil, fmt.Errorf("unfurl: private/reserved address")
			}
			return dialer.DialContext(ctx, network, addr)
		},
	}
	return &Service{
		q:   db.New(pool),
		log: log,
		cli: &http.Client{
			Transport: tr,
			Timeout:   fetchTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= maxRedirects {
					return errors.New("unfurl: too many redirects")
				}
				return validTarget(req.URL)
			},
		},
	}
}

// forbiddenPrefixes covers non-global ranges netip's predicates miss:
// CGNAT (Tailscale nets live there), IETF assignments, docs ranges,
// benchmarking, and IPv6 docs/special space.
var forbiddenPrefixes = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func forbidden(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() ||
		a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsMulticast() ||
		a.IsUnspecified() {
		return true
	}
	for _, p := range forbiddenPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func validTarget(u *url.URL) error {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("unfurl: scheme must be http(s)")
	}
	if u.User != nil {
		return fmt.Errorf("unfurl: userinfo not allowed")
	}
	if u.Hostname() == "" {
		return fmt.Errorf("unfurl: empty host")
	}
	return nil
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/unfurl", s.handle)
}

func (s *Service) handle(c *gin.Context) {
	raw := c.Query("url")
	if len(raw) == 0 || len(raw) > maxURL {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid url")
		return
	}
	u, err := url.Parse(raw)
	if err != nil || validTarget(u) != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "invalid url")
		return
	}
	if row, err := s.q.GetLinkPreview(c.Request.Context(), u.String()); err == nil {
		// failures cache for an hour only — a dead endpoint may come back
		if !row.FailedAt.Valid || time.Since(row.FetchedAt.Time) < failureTTL {
			s.respond(c, row)
			return
		}
	}
	row := s.fetch(c.Request.Context(), u.String())
	s.respond(c, row)
}

func (s *Service) respond(c *gin.Context, row db.LinkPreview) {
	if row.FailedAt.Valid || row.Title == "" {
		c.JSON(http.StatusOK, gin.H{"found": false, "url": row.Url})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"found": true, "url": row.Url,
		"title": row.Title, "description": row.Description,
		"image_url": row.ImageUrl, "site_name": row.SiteName,
	})
}

// fetch loads the page, parses OG tags, and caches the outcome — including
// failures, so a dead link doesn't get re-fetched on every render.
func (s *Service) fetch(ctx context.Context, raw string) db.LinkPreview {
	row := db.LinkPreview{Url: raw}
	now := time.Now()
	defer func() {
		params := db.UpsertLinkPreviewParams{
			Url: row.Url, Title: row.Title, Description: row.Description,
			ImageUrl: row.ImageUrl, SiteName: row.SiteName,
		}
		if row.Title == "" {
			params.FailedAt = pgtype.Timestamptz{Time: now, Valid: true}
		}
		if err := s.q.UpsertLinkPreview(ctx, params); err != nil {
			s.log.Warn("preview cache write failed", zap.Error(err))
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return row
	}
	req.Header.Set("User-Agent", "Relay-Unfurl/1.0 (+link preview)")
	req.Header.Set("Accept", "text/html")
	resp, err := s.cli.Do(req)
	if err != nil {
		return row
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return row
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" &&
		!strings.HasPrefix(strings.ToLower(ct), "text/html") {
		return row
	}
	doc, err := html.Parse(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return row
	}
	og, tw, title := extract(doc)
	row.Title = clip(first(og["title"], tw["title"], title), 300)
	row.Description = clip(first(og["description"], tw["description"]), 500)
	row.SiteName = clip(og["site_name"], 200)
	if img := first(og["image"], og["image:url"], tw["image"]); img != "" {
		if abs, err := uAbs(raw, img); err == nil {
			row.ImageUrl = abs
		}
	}
	return row
}

func first(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func uAbs(base, ref string) (string, error) {
	b, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	r, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	abs := b.ResolveReference(r)
	if err := validTarget(abs); err != nil {
		return "", err
	}
	return abs.String(), nil
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// extract walks the parsed document once, collecting og:/twitter: meta
// properties and the <title> text.
func extract(doc *html.Node) (og, tw map[string]string, title string) {
	og, tw = map[string]string{}, map[string]string{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "meta":
				var prop, name, content string
				for _, a := range n.Attr {
					switch a.Key {
					case "property":
						prop = a.Val
					case "name":
						name = a.Val
					case "content":
						content = a.Val
					}
				}
				if content == "" {
					break
				}
				if rest, ok := strings.CutPrefix(prop, "og:"); ok {
					if _, seen := og[rest]; !seen {
						og[rest] = content
					}
				}
				if rest, ok := strings.CutPrefix(name, "twitter:"); ok {
					if _, seen := tw[rest]; !seen {
						tw[rest] = content
					}
				}
			case "title":
				if title == "" && n.FirstChild != nil {
					title = n.FirstChild.Data
				}
			}
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(doc)
	return og, tw, title
}
