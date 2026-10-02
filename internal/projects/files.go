// Local-folder browsing: read-only tree + file-read endpoints over a
// project's linked directory (projects.local_path). Used by the composer's
// file mentions and the project's Files tab.
package projects

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Dvorinka/relay/internal/httpx"
	"github.com/Dvorinka/relay/internal/localfiles"
	"github.com/gin-gonic/gin"
)

func (s *Service) projectRoot(c *gin.Context) (string, bool) {
	p := CurrentProject(c)
	if !p.LocalPath.Valid || p.LocalPath.String == "" {
		httpx.Error(c, http.StatusNotFound, "no_local_path", "no folder linked to this project")
		return "", false
	}
	return p.LocalPath.String, true
}

// handleFiles lists one directory level (?path=sub/dir, default root).
// ?recursive=1 returns a flattened depth-limited tree of files only —
// powers the composer's path autocomplete.
func (s *Service) handleFiles(c *gin.Context) {
	root, ok := s.projectRoot(c)
	if !ok {
		return
	}
	if c.Query("recursive") == "1" {
		s.handleRecursive(c, root)
		return
	}
	dir, ok := localfiles.ResolveInRoot(root, c.DefaultQuery("path", ""))
	if !ok {
		httpx.Error(c, http.StatusNotFound, "not_found", "path not found")
		return
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "path not found")
		return
	}
	type entry struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Dir  bool   `json:"dir"`
		Size int64  `json:"size,omitempty"`
	}
	out := make([]entry, 0, len(ents))
	for _, e := range ents {
		if e.IsDir() && localfiles.SkipDirs[e.Name()] {
			continue
		}
		if !e.IsDir() && localfiles.Sensitive(e.Name()) {
			continue
		}
		var size int64
		if !e.IsDir() {
			if fi, err := e.Info(); err == nil {
				size = fi.Size()
			}
		}
		out = append(out, entry{
			Name: e.Name(),
			Path: filepath.Join(c.DefaultQuery("path", ""), e.Name()),
			Dir:  e.IsDir(), Size: size,
		})
		if len(out) >= localfiles.MaxTreeEntries {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	c.JSON(http.StatusOK, gin.H{"entries": out, "truncated": len(ents) > len(out)})
}

// handleRecursive walks the tree (depth <=6, SkipDirs excluded) and returns
// every file as a flat path list, capped at MaxTreeEntries.
func (s *Service) handleRecursive(c *gin.Context, root string) {
	type entry struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Dir  bool   `json:"dir"`
	}
	out := []entry{}
	var walk func(dir, rel string, depth int) bool // false = cap reached
	walk = func(dir, rel string, depth int) bool {
		if depth > 6 {
			return true
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			return true
		}
		for _, e := range ents {
			if e.IsDir() {
				if localfiles.SkipDirs[e.Name()] {
					continue
				}
				if !walk(filepath.Join(dir, e.Name()), filepath.Join(rel, e.Name()), depth+1) {
					return false
				}
				continue
			}
			if localfiles.Sensitive(e.Name()) {
				continue
			}
			out = append(out, entry{Name: e.Name(), Path: filepath.Join(rel, e.Name())})
			if len(out) >= localfiles.MaxTreeEntries {
				return false
			}
		}
		return true
	}
	truncated := !walk(root, "", 0)
	c.JSON(http.StatusOK, gin.H{"entries": out, "truncated": truncated})
}

// handleReadFile returns a text file's content (UTF-8, ≤256KB).
func (s *Service) handleReadFile(c *gin.Context) {
	root, ok := s.projectRoot(c)
	if !ok {
		return
	}
	full, ok := localfiles.ResolveInRoot(root, c.Query("path"))
	if !ok || localfiles.Sensitive(filepath.Base(full)) {
		httpx.Error(c, http.StatusNotFound, "not_found", "path not found")
		return
	}
	st, err := os.Stat(full)
	if err != nil || st.IsDir() {
		httpx.Error(c, http.StatusNotFound, "not_found", "not a file")
		return
	}
	if st.Size() > localfiles.MaxReadBytes {
		httpx.Error(c, http.StatusRequestEntityTooLarge, "too_large", "file exceeds 256KB")
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data[:min(len(data), 8192)]), 0) >= 0 {
		httpx.Error(c, http.StatusUnsupportedMediaType, "binary", "not a text file")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"path":    c.Query("path"),
		"content": string(data),
		"size":    st.Size(),
	})
}
