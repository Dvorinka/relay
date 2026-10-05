// Package agentdoc serves the canonical agent onboarding guide. It is
// embedded in the server binary so the same instructions reach agents
// through every surface — the get_guide MCP tool, `relay-cli guide`, and
// GET /api/agent-guide — without anyone downloading anything.
package agentdoc

import _ "embed"

//go:embed guide.md
var Guide string
