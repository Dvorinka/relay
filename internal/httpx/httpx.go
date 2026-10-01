// Package httpx holds the shared HTTP surface: the spec's error envelope,
// request binding, and uuid parsing for path params.
package httpx

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
)

func Error(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": message}})
}

var ErrBadJSON = errors.New("invalid request body")

// BindJSON decodes a JSON body and reports the spec envelope on failure.
func BindJSON(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		Error(c, http.StatusBadRequest, "bad_request", ErrBadJSON.Error())
		return false
	}
	return true
}

// PathUUID parses a uuid path parameter or writes a 400.
func PathUUID(c *gin.Context, name string) (pgtype.UUID, bool) {
	var id pgtype.UUID
	if err := id.Scan(c.Param(name)); err != nil {
		Error(c, http.StatusBadRequest, "bad_request", "invalid "+name)
		return id, false
	}
	return id, true
}
