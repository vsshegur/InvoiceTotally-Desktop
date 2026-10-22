//go:build windows

// InvoiceTotally Setup: installs for this Windows user only (no administrator needed) into
// %LOCALAPPDATA%\Programs\InvoiceTotally, adds Desktop and Start menu shortcuts and an entry in
// Settings → Apps. Your data (%LOCALAPPDATA%\InvoiceTotally) is never touched by installing or updating.
package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

//go:embed payload.zip
var payload []byte

//go:embed version.txt
var version string

const createNoWindow = 0x08000000

func hidden(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
	return c
}
func psQuote(s string) string { return strings.ReplaceAll(s, "'", "''") }
func message(text string, flags uintptr) int {
	u := syscall.NewLazyDLL("user32.dll")
	p := u.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	h, _ := syscall.UTF16PtrFromString("Vipul Workplace Setup")
	r, _, _ := p.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(h)), flags)
	return int(r)
}

func main() {
	quiet := len(os.Args) > 1 && os.Args[1] == "--quiet"
	fail := func(msg string) {
		if quiet {
			fmt.Fprintln(os.Stderr, msg)
			os.Exit(1)
		}
		message(msg, 0x10)
		os.Exit(1)
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		local, _ = os.UserHomeDir()
	}
	dir := filepath.Join(local, "Programs", "InvoiceTotally")
	if v := os.Getenv("IT_INSTALL_DIR"); v != "" {
		dir = v
	}
	// a running copy is asked to stop first (it finishes what it is posting to Tally)
	stopRunning()

	zr, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		fail("The installer is damaged: " + err.Error())
	}
	// the app folder is replaced as a whole; the runtime only when it changed
	_ = os.RemoveAll(filepath.Join(dir, "app"))
	for _, f := range zr.File {
		dst := filepath.Join(dir, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(dst, filepath.Clean(dir)+string(os.PathSeparator)) {
			fail("The installer is damaged (bad path)")
		}
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(dst, 0755)
			continue
		}
		if st, e := os.Stat(dst); e == nil && st.Size() == int64(f.UncompressedSize64) && strings.HasPrefix(f.Name, "runtime/") {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(dst), 0755)
		rc, e := f.Open()
		if e != nil {
			fail("Could not install: " + e.Error())
		}
		tmp := dst + ".new"
		out, e := os.Create(tmp)
		if e != nil {
			rc.Close()
			fail("Could not install " + f.Name + ": " + e.Error() + "\n\nClose Vipul Workplace and run Setup again.")
		}
		_, e = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if e != nil {
			fail("Could not install " + f.Name + ": " + e.Error())
		}
		_ = os.Remove(dst)
		if e = os.Rename(tmp, dst); e != nil {
			fail("Could not replace " + f.Name + ": " + e.Error() + "\n\nClose Vipul Workplace and run Setup again.")
		}
	}

	exe := filepath.Join(dir, "InvoiceTotally.exe")
	ico := filepath.Join(dir, "InvoiceTotally.ico")
	un := filepath.Join(dir, "Uninstall InvoiceTotally.exe")
	programs := filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs")
	links := [][2]string{
		{filepath.Join(os.Getenv("USERPROFILE"), "Desktop", "Vipul Workplace.lnk"), exe},
		{filepath.Join(programs, "Vipul Workplace.lnk"), exe},
	}
	for _, l := range links {
		script := fmt.Sprintf(`$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut('%s');$s.TargetPath='%s';$s.WorkingDirectory='%s';$s.IconLocation='%s,0';$s.Description='Vipul Workplace — offline accounting and GST workbench';$s.Save()`,
			psQuote(l[0]), psQuote(l[1]), psQuote(dir), psQuote(ico))
		_ = hidden("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script).Run()
	}
	// Remove legacy shortcut names, never touch the existing program/data folder.
	for _, old := range []string{
		filepath.Join(os.Getenv("USERPROFILE"), "Desktop", "InvoiceTotally.lnk"),
		filepath.Join(programs, "InvoiceTotally.lnk"),
	} { _ = os.Remove(old) }
	// Settings → Apps → Installed apps
	key := `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InvoiceTotally`
	for _, kv := range [][3]string{
		{"DisplayName", "REG_SZ", "Vipul Workplace"}, {"DisplayVersion", "REG_SZ", strings.TrimSpace(version)},
		{"Publisher", "REG_SZ", "Vipul Workplace"}, {"DisplayIcon", "REG_SZ", ico}, {"InstallLocation", "REG_SZ", dir},
		{"UninstallString", "REG_SZ", `"` + un + `"`}, {"NoModify", "REG_DWORD", "1"}, {"NoRepair", "REG_DWORD", "1"},
	} {
		_ = hidden("reg.exe", "add", key, "/v", kv[0], "/t", kv[1], "/d", kv[2], "/f").Run()
	}
	if quiet {
		fmt.Println("installed to", dir)
		return
	}
	_ = exec.Command(exe).Start()
	message("Vipul Workplace "+strings.TrimSpace(version)+" is installed.\n\nOpen it any time from the Vipul Workplace icon on your desktop or in the Start menu. Your data is kept when you update.", 0x40)
}

func stopRunning() {
	c := http.Client{Timeout: 2 * time.Second}
	r, err := c.Get("http://127.0.0.1:47821/api/health")
	if err != nil {
		return
	}
	r.Body.Close()
	local := os.Getenv("LOCALAPPDATA")
	key, _ := os.ReadFile(filepath.Join(local, "InvoiceTotally", "window.key"))
	req, _ := http.NewRequest("POST", "http://127.0.0.1:47821/api/quit", nil)
	req.Header.Set("x-it-key", strings.TrimSpace(string(key)))
	if r, err := c.Do(req); err == nil {
		r.Body.Close()
	}
	for i := 0; i < 240; i++ {
		time.Sleep(250 * time.Millisecond)
		if r, err := c.Get("http://127.0.0.1:47821/api/health"); err != nil {
			return
		} else {
			r.Body.Close()
		}
	}
}
