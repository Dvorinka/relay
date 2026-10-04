package auth

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
)

func (s *Service) RegisterRoutes(g *gin.RouterGroup) {
	pub := g.Group("/auth")
	pub.POST("/register", s.RateLimit("register", 5, 3600), s.handleRegister)
	pub.POST("/login", s.RateLimit("login", 10, 60), s.handleLogin)
	pub.POST("/password/forgot", s.RateLimit("forgot", 5, 3600), s.handleForgot)
	pub.POST("/password/reset", s.RateLimit("reset", 10, 60), s.handleReset)
	pub.POST("/browser/start", s.RateLimit("browser-start", 10, 60), s.handleBrowserStart)
	pub.GET("/browser/poll", s.RateLimit("browser-poll", 60, 60), s.handleBrowserPoll)

	priv := g.Group("/auth", s.RequireAuth)
	priv.POST("/logout", s.handleLogout)
	priv.GET("/session", s.handleSession)
	priv.POST("/password/change", s.handleChangePassword)
	priv.PATCH("/me", s.handleUpdateMe)
	priv.POST("/browser/approve", s.RateLimit("browser-approve", 20, 60), s.handleBrowserApprove)
}

// --- request/response shapes (mirrors api/openapi.yaml) ---

type registerRequest struct {
	Email    string `json:"email" binding:"required"`
	Password string `json:"password" binding:"required"`
	Name     string `json:"name" binding:"required"`
}

type loginRequest struct {
	Email    string `json:"email" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type workspaceOut struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
	Role string `json:"role"`
}

type sessionOut struct {
	User       userOut        `json:"user"`
	Workspaces []workspaceOut `json:"workspaces"`
	Token      string         `json:"token,omitempty"`
}

type userOut struct {
	ID        string  `json:"id"`
	Email     string  `json:"email"`
	Name      string  `json:"name"`
	NameColor *string `json:"name_color"`
	AvatarURL *string `json:"avatar_url"`
	CreatedAt string  `json:"created_at"`
}

func toSessionOut(c Credentials) sessionOut {
	out := sessionOut{
		User:       UserOut(c.User),
		Workspaces: make([]workspaceOut, 0, len(c.Workspaces)),
	}
	for _, w := range c.Workspaces {
		out.Workspaces = append(out.Workspaces, workspaceOut{
			ID: w.ID.String(), Name: w.Name, Slug: w.Slug, Role: w.Role,
		})
	}
	return out
}

// UserOut is exported for the workspaces package (member lists).
func UserOut(u db.GetUserByIDRow) userOut {
	var avatar *string
	if u.AvatarKey.Valid {
		v := "/api/files/" + u.AvatarKey.String // avatar served once storage lands (phase 4)
		avatar = &v
	}
	var color *string
	if u.NameColor.Valid {
		color = &u.NameColor.String
	}
	return userOut{
		ID: u.ID.String(), Email: u.Email, Name: u.Name, NameColor: color,
		AvatarURL: avatar,
		CreatedAt: u.CreatedAt.Time.Format("2006-01-02T15:04:05Z07:00"),
	}
}

var nameColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// handleUpdateMe patches profile fields. name_color accepts "#rrggbb" or
// empty (clears back to the palette default).
func (s *Service) handleUpdateMe(c *gin.Context) {
	user := CurrentUser(c)
	var req struct {
		NameColor *string `json:"name_color"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.NameColor == nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "nothing to update")
		return
	}
	v := strings.TrimSpace(*req.NameColor)
	if v != "" && !nameColorPattern.MatchString(v) {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name_color must be #rrggbb or empty")
		return
	}
	row, err := s.q.UpdateUserNameColor(c.Request.Context(), db.UpdateUserNameColorParams{
		ID:        user.ID,
		NameColor: pgtype.Text{String: strings.ToLower(v), Valid: v != ""},
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": UserOut(db.GetUserByIDRow(row))})
}

// --- handlers ---

func (s *Service) handleRegister(c *gin.Context) {
	var req registerRequest
	if !httpx.BindJSON(c, &req) {
		return
	}
	creds, token, err := s.Register(c.Request.Context(), req.Email, req.Password, req.Name, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		switch {
		case errors.Is(err, ErrEmailTaken):
			httpx.Error(c, http.StatusConflict, "email_taken", err.Error())
		default:
			httpx.Error(c, http.StatusBadRequest, "bad_request", err.Error())
		}
		return
	}
	s.setCookie(c, token)
	out := toSessionOut(creds)
	out.Token = token
	c.JSON(http.StatusCreated, out)
}

func (s *Service) handleLogin(c *gin.Context) {
	var req loginRequest
	if !httpx.BindJSON(c, &req) {
		return
	}
	creds, token, err := s.Login(c.Request.Context(), req.Email, req.Password, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		if errors.Is(err, ErrBadCredentials) {
			httpx.Error(c, http.StatusUnauthorized, "bad_credentials", "invalid email or password")
			return
		}
		s.log.Error("login failed")
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.setCookie(c, token)
	out := toSessionOut(creds)
	out.Token = token
	c.JSON(http.StatusOK, out)
}

func (s *Service) handleLogout(c *gin.Context) {
	if raw, err := c.Cookie(SessionCookie); err == nil {
		_ = s.Logout(c.Request.Context(), raw)
	}
	s.clearCookie(c)
	c.Status(http.StatusNoContent)
}

func (s *Service) handleSession(c *gin.Context) {
	creds, err := s.Session(c.Request.Context(), CurrentUser(c))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, toSessionOut(creds))
}

func (s *Service) handleForgot(c *gin.Context) {
	var req struct {
		Email string `json:"email" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if err := s.ForgotPassword(c.Request.Context(), req.Email); err != nil {
		s.log.Error("forgot-password mailer failed")
	}
	c.Status(http.StatusNoContent)
}

func (s *Service) handleReset(c *gin.Context) {
	var req struct {
		Token    string `json:"token" binding:"required"`
		Password string `json:"password" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if err := s.ResetPassword(c.Request.Context(), req.Token, req.Password); err != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Service) handleChangePassword(c *gin.Context) {
	var req struct {
		CurrentPassword string `json:"current_password" binding:"required"`
		NewPassword     string `json:"new_password" binding:"required"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	user := CurrentUser(c)
	tokenHash, _ := c.Get(ctxTokenHash)
	if err := s.ChangePassword(c.Request.Context(), user.ID, tokenHash.(string), req.CurrentPassword, req.NewPassword); err != nil {
		if errors.Is(err, ErrBadCredentials) {
			httpx.Error(c, http.StatusUnauthorized, "bad_credentials", "current password is wrong")
			return
		}
		httpx.Error(c, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	c.Status(http.StatusNoContent)
}
