// Package push: Web Push (VAPID) delivery plus the subscription endpoints.
// Triggered from message/review creation points — mentions, replies, and
// pending reviews notify the relevant project's users. Keys come from env;
// absent keys get an ephemeral pair (dev mode — subscriptions silently stop
// on restart, clients re-subscribe on next login).
package push

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/config"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

type Service struct {
	q     *db.Queries
	log   *zap.Logger
	pub   string
	priv  string
	subj  string
	ephem bool // keys were generated, not configured
}

func NewService(log *zap.Logger, pool *pgxpool.Pool, cfg config.Config) *Service {
	s := &Service{q: db.New(pool), log: log,
		pub: cfg.VapidPublic, priv: cfg.VapidPrivate, subj: cfg.VapidSubject}
	if s.pub == "" || s.priv == "" {
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			log.Warn("web push disabled: key generation failed", zap.Error(err))
			return s
		}
		s.priv, s.pub = priv, pub
		s.ephem = true
		log.Warn("web push using ephemeral VAPID keys — set RELAY_VAPID_PUBLIC_KEY/RELAY_VAPID_PRIVATE_KEY for stable delivery")
	}
	return s
}

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	g.GET("/push/vapid", s.handleVAPID)
	g.PUT("/push/subscriptions", s.handleSubscribe)
	g.DELETE("/push/subscriptions", s.handleUnsubscribe)
}

// handleVAPID hands the browser the application-server key it must subscribe
// with. ephemeral=true tells the UI to warn that restarts drop delivery.
func (s *Service) handleVAPID(c *gin.Context) {
	if s.pub == "" {
		c.JSON(http.StatusOK, gin.H{"enabled": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"enabled": true, "public_key": s.pub, "ephemeral": s.ephem})
}

func (s *Service) handleSubscribe(c *gin.Context) {
	var req struct {
		Endpoint string `json:"endpoint" binding:"required"`
		Keys     struct {
			P256dh string `json:"p256dh" binding:"required"`
			Auth   string `json:"auth" binding:"required"`
		} `json:"keys" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if s.pub == "" {
		httpx.Error(c, http.StatusServiceUnavailable, "push_disabled", "server has no VAPID keys")
		return
	}
	keys, _ := json.Marshal(req.Keys)
	if err := s.q.UpsertPushSubscription(c.Request.Context(), db.UpsertPushSubscriptionParams{
		UserID: auth.CurrentUser(c).ID, Endpoint: req.Endpoint,
		Auth: req.Keys.Auth, Keys: keys, UserAgent: pgtype.Text{String: c.Request.UserAgent(), Valid: true},
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"subscribed": true})
}

func (s *Service) handleUnsubscribe(c *gin.Context) {
	var req struct {
		Endpoint string `json:"endpoint" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	_ = s.q.DeletePushSubscription(c.Request.Context(), db.DeletePushSubscriptionParams{
		Endpoint: req.Endpoint, UserID: auth.CurrentUser(c).ID,
	})
	c.JSON(http.StatusOK, gin.H{"subscribed": false})
}

// Payload is what the service worker turns into a Notification.
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

// Notify sends p to each user's subscriptions; dead endpoints are pruned.
func (s *Service) Notify(ctx context.Context, users []pgtype.UUID, p Payload) {
	if s.pub == "" {
		return
	}
	body, _ := json.Marshal(p)
	for _, u := range users {
		subs, err := s.q.ListPushSubscriptions(ctx, u)
		if err != nil {
			continue
		}
		for _, sub := range subs {
			var keys struct {
				P256dh string `json:"p256dh"`
				Auth   string `json:"auth"`
			}
			if json.Unmarshal(sub.Keys, &keys) != nil {
				continue
			}
			resp, err := webpush.SendNotification(body, &webpush.Subscription{
				Endpoint: sub.Endpoint,
				Keys:     webpush.Keys{P256dh: keys.P256dh, Auth: keys.Auth},
			}, &webpush.Options{
				VAPIDPublicKey:  s.pub,
				VAPIDPrivateKey: s.priv,
				Subscriber:      s.subj,
				TTL:             300,
			})
			if err != nil {
				s.log.Debug("push send failed", zap.Error(err))
				continue
			}
			// 404/410: browser dropped the subscription — stop holding it
			if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
				_ = s.q.DeletePushSubscription(ctx, db.DeletePushSubscriptionParams{
					Endpoint: sub.Endpoint, UserID: u,
				})
			}
			_ = resp.Body.Close()
		}
	}
}

// NotifyMessage targets users mentioned as @name plus the replied-to author,
// minus the sender. Runs detached — a slow push gateway must not stall chat.
func (s *Service) NotifyMessage(projectID pgtype.UUID, sender pgtype.UUID,
	body string, messageID pgtype.UUID, projectURL, authorName string) {
	if s.pub == "" {
		return
	}
	go func() {
		ctx := context.Background()
		targets := map[[16]byte]bool{}
		if ids, err := s.q.MentionedUserIDs(ctx, db.MentionedUserIDsParams{
			ID: projectID, Lower: body,
		}); err == nil {
			for _, id := range ids {
				targets[id.Bytes] = true
			}
		}
		if parent, err := s.q.ParentAuthorID(ctx, messageID); err == nil && parent.Valid {
			targets[parent.Bytes] = true
		}
		if sender.Valid {
			delete(targets, sender.Bytes)
		}
		users := make([]pgtype.UUID, 0, len(targets))
		for b := range targets {
			users = append(users, pgtype.UUID{Bytes: b, Valid: true})
		}
		if len(users) == 0 {
			return
		}
		short := body
		if len(short) > 140 {
			short = short[:140] + "…"
		}
		s.Notify(ctx, users, Payload{
			Title: authorName + " in Relay", Body: short, URL: projectURL,
			Tag: "msg-" + messageID.String(),
		})
	}()
}

// NotifyProject pings every project member (e.g. an agent asked for review).
func (s *Service) NotifyProject(projectID pgtype.UUID, p Payload) {
	if s.pub == "" {
		return
	}
	go func() {
		ctx := context.Background()
		users, err := s.q.ListProjectMemberIDs(ctx, projectID)
		if err == nil {
			s.Notify(ctx, users, p)
		}
	}()
}
