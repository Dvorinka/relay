package main

import (
	"bytes"
	"os"
	"runtime"
	"testing"
)

// Real end-to-end self-update: downloads the actual GitHub release asset,
// renames it over the running executable, and spawns the waiter that re-execs
// after exit. Gated behind RELAY_E2E=1 — it network-hits GitHub and replaces
// the test binary on disk. The waiter's re-exec runs the release binary once
// the test process exits; headless it just panics on GTK init and dies.
func TestSelfUpdateLinuxE2E(t *testing.T) {
	if os.Getenv("RELAY_E2E") != "1" || runtime.GOOS != "linux" {
		t.Skip("set RELAY_E2E=1 to run the live self-update check")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&App{}).SelfUpdate("v1.0.35"); err != nil {
		t.Fatalf("SelfUpdate: %v", err)
	}
	after, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(before, after) {
		t.Fatal("executable unchanged after self-update")
	}
	if !bytes.HasPrefix(after, []byte("\x7fELF")) {
		t.Fatal("updated binary is not an ELF")
	}
	if _, err := os.Stat(exe + ".new"); !os.IsNotExist(err) {
		t.Fatal("stale .new file left behind")
	}
	t.Logf("swapped %d -> %d bytes", len(before), len(after))
}
