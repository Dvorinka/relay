// Project views: custom issue statuses, the linked local folder, saved
// issue filters, and named boards. All live under /projects/:id behind the
// workspace-member gate.
package projects

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Dvorinka/relay/internal/auth"
	"github.com/Dvorinka/relay/internal/db"
	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/statuses"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
)

// --- custom statuses ---

func (s *Service) handleSetStatuses(c *gin.Context) {
	p := CurrentProject(c)
	var req struct {
		Statuses []statuses.Def `json:"statuses"` // null resets to defaults
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	if req.Statuses == nil {
		if err := s.q.SetProjectStatuses(c.Request.Context(), db.SetProjectStatusesParams{
			ID: p.ID, Statuses: nil,
		}); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		c.JSON(http.StatusOK, gin.H{"statuses": statuses.Defaults()})
		return
	}
	if msg, ok := statuses.Validate(req.Statuses); !ok {
		httpx.Error(c, http.StatusBadRequest, "bad_request", msg)
		return
	}
	raw, _ := json.Marshal(req.Statuses)
	if err := s.q.SetProjectStatuses(c.Request.Context(), db.SetProjectStatusesParams{
		ID: p.ID, Statuses: raw,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"statuses": req.Statuses})
}

// --- local folder link ---

func (s *Service) handleSetLocalPath(c *gin.Context) {
	p := CurrentProject(c)
	var req struct {
		Path *string `json:"path"` // null clears
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	var val pgtype.Text
	if req.Path != nil && strings.TrimSpace(*req.Path) != "" {
		path := filepath.Clean(strings.TrimSpace(*req.Path))
		if !filepath.IsAbs(path) {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "path must be absolute")
			return
		}
		// resolve symlinks so the files endpoints and this check agree
		if rp, err := filepath.EvalSymlinks(path); err == nil {
			path = rp
		}
		st, err := os.Stat(path)
		if err != nil || !st.IsDir() {
			httpx.Error(c, http.StatusBadRequest, "bad_request", "path does not exist or is not a directory")
			return
		}
		val = pgtype.Text{String: path, Valid: true}
	}
	if err := s.q.SetProjectLocalPath(c.Request.Context(), db.SetProjectLocalPathParams{
		ID: p.ID, LocalPath: val,
	}); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusOK, gin.H{"local_path": textOrNil(val)})
}

// --- saved filters ---

func (s *Service) handleListFilters(c *gin.Context) {
	p := CurrentProject(c)
	rows, err := s.q.ListSavedFilters(c.Request.Context(), db.ListSavedFiltersParams{
		ProjectID: p.ID, UserID: auth.CurrentUser(c).ID,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id": r.ID.String(), "name": r.Name,
			"filters": json.RawMessage(r.Filters),
		})
	}
	c.JSON(http.StatusOK, gin.H{"filters": out})
}

func (s *Service) handleCreateFilter(c *gin.Context) {
	p := CurrentProject(c)
	var req struct {
		Name    string          `json:"name" binding:"required"`
		Filters json.RawMessage `json:"filters"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 60 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name must be 1-60 characters")
		return
	}
	var obj map[string]any
	if len(req.Filters) == 0 || json.Unmarshal(req.Filters, &obj) != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "filters must be a JSON object")
		return
	}
	if len(req.Filters) > 8192 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "filters too large")
		return
	}
	row, err := s.q.CreateSavedFilter(c.Request.Context(), db.CreateSavedFilterParams{
		ProjectID: p.ID, UserID: auth.CurrentUser(c).ID, Name: req.Name, Filters: req.Filters,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": row.ID.String(), "name": row.Name, "filters": json.RawMessage(row.Filters),
	})
}

func (s *Service) handleDeleteFilter(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "filterID")
	if !ok {
		return
	}
	_ = s.q.DeleteSavedFilter(c.Request.Context(), db.DeleteSavedFilterParams{
		ID: id, UserID: auth.CurrentUser(c).ID,
	})
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// --- named boards ---

func (s *Service) handleListBoards(c *gin.Context) {
	p := CurrentProject(c)
	rows, err := s.q.ListBoards(c.Request.Context(), p.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id": r.ID.String(), "name": r.Name,
			"filters": json.RawMessage(r.Filters),
		})
	}
	c.JSON(http.StatusOK, gin.H{"boards": out})
}

func (s *Service) handleCreateBoard(c *gin.Context) {
	p := CurrentProject(c)
	var req struct {
		Name    string          `json:"name" binding:"required"`
		Filters json.RawMessage `json:"filters"`
	}
	if !httpx.BindJSON(c, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 60 {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "name must be 1-60 characters")
		return
	}
	if len(req.Filters) == 0 {
		req.Filters = json.RawMessage("{}")
	}
	var obj map[string]any
	if json.Unmarshal(req.Filters, &obj) != nil {
		httpx.Error(c, http.StatusBadRequest, "bad_request", "filters must be a JSON object")
		return
	}
	row, err := s.q.CreateBoard(c.Request.Context(), db.CreateBoardParams{
		ProjectID: p.ID, Name: req.Name, Filters: req.Filters,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": row.ID.String(), "name": row.Name, "filters": json.RawMessage(row.Filters),
	})
}

func (s *Service) handleDeleteBoard(c *gin.Context) {
	id, ok := httpx.PathUUID(c, "boardID")
	if !ok {
		return
	}
	_ = s.q.DeleteBoard(c.Request.Context(), id)
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}
