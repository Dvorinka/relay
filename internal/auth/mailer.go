package auth

import (
	"context"

	"go.uber.org/zap"
)

// Mailer sends transactional email. v1 ships a log mailer; SMTP lands when
// a deployment actually configures it.
type Mailer interface {
	Send(ctx context.Context, to, subject, body string) error
}

type LogMailer struct{ log *zap.Logger }

func NewLogMailer(log *zap.Logger) LogMailer {
	return LogMailer{log: log}
}

func (m LogMailer) Send(_ context.Context, to, subject, body string) error {
	// Dev path: the link is the point, log it verbatim.
	m.log.Info("mail (log mailer)", zap.String("to", to), zap.String("subject", subject), zap.String("body", body))
	return nil
}
