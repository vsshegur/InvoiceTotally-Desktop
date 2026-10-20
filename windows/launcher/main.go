//go:build windows

// InvoiceTotally.exe — what the desktop icon starts.
//
// It starts the app (the bundled Node runtime running app\desktop\main.mjs, hidden) unless it is already running,
// then opens the app window: Microsoft Edge in app mode with its own profile, so it looks like a normal program
// window. When that window closes, the app is asked to stop (it first finishes anything it is posting to Tally).
package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const port = "47821"
const createNoWindow = 0x08000000

var base = "http://127.0.0.1:" + port

func message(text string) {
	u := syscall.NewLazyDLL("user32.dll")
	p := u.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	h, _ := syscall.UTF16PtrFromString("InvoiceTotally")
	p.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(h)), 0x30)
}

func running() bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	r, err := c.Get(base + "/api/health")
	if err != nil {
		return false
	}
	r.Body.Close()
	return r.StatusCode == 200
}

func dataDir() string {
	b := os.Getenv("LOCALAPPDATA")
	if b == "" {
		b, _ = os.UserHomeDir()
	}
	return filepath.Join(b, "InvoiceTotally")
}

func browser() string {
	var c []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if v := os.Getenv(env); v != "" {
			c = append(c, filepath.Join(v, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	}
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
		if v := os.Getenv(env); v != "" {
			c = append(c, filepath.Join(v, "Google", "Chrome", "Application", "chrome.exe"))
		}
	}
	for _, p := range c {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func main() {
	self, _ := os.Executable()
	dir := filepath.Dir(self)
	data := dataDir()
	_ = os.MkdirAll(filepath.Join(data, "logs"), 0700)

	started := false
	if !running() {
		node := filepath.Join(dir, "runtime", "node.exe")
		script := filepath.Join(dir, "app", "desktop", "main.mjs")
		logf, _ := os.OpenFile(filepath.Join(data, "logs", "start.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
		cmd := exec.Command(node, "--disable-warning=ExperimentalWarning", script)
		cmd.Dir = filepath.Join(dir, "app")
		cmd.Env = append(os.Environ(), "IT_DATA_DIR="+data)
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
		if logf != nil {
			cmd.Stdout, cmd.Stderr = logf, logf
		}
		if err := cmd.Start(); err != nil {
			message("InvoiceTotally could not start:\n\n" + err.Error() + "\n\nTry installing it again.")
			return
		}
		started = true
		ok := false
		for i := 0; i < 60; i++ { // up to 15 seconds
			time.Sleep(250 * time.Millisecond)
			if running() {
				ok = true
				break
			}
		}
		if !ok {
			b, _ := os.ReadFile(filepath.Join(data, "logs", "start.log"))
			tail := strings.TrimSpace(string(b))
			if len(tail) > 600 {
				tail = tail[len(tail)-600:]
			}
			message("InvoiceTotally did not start.\n\n" + tail + "\n\nDetails are in " + filepath.Join(data, "logs"))
			_ = cmd.Process.Kill()
			return
		}
	}

	key, _ := os.ReadFile(filepath.Join(data, "window.key"))
	url := "http://localhost:" + port + "/#k=" + strings.TrimSpace(string(key))
	b := browser()
	if b == "" {
		// No Edge or Chrome: the ordinary browser works too (the app keeps running until Windows signs out).
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		return
	}
	win := exec.Command(b, "--app="+url, "--user-data-dir="+filepath.Join(data, "window"), "--no-first-run",
		"--no-default-browser-check", "--disable-background-mode", "--disable-features=Translate,msEdgeStartupBoost",
		"--window-size=1366,880", "--class=InvoiceTotally")
	if err := win.Start(); err != nil {
		message("Could not open the InvoiceTotally window:\n\n" + err.Error())
		return
	}
	_ = win.Wait()
	if !started {
		return // another InvoiceTotally.exe opened the app; it closes it
	}
	// The window is closed: the app finishes what it is posting to Tally, then stops.
	req, _ := http.NewRequest("POST", base+"/api/quit", nil)
	req.Header.Set("x-it-key", strings.TrimSpace(string(key)))
	c := http.Client{Timeout: 5 * time.Second}
	if r, err := c.Do(req); err == nil {
		r.Body.Close()
	}
	for i := 0; i < 600 && running(); i++ { // up to 2.5 minutes
		time.Sleep(250 * time.Millisecond)
	}
	fmt.Print()
}
