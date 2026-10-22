//go:build windows

// Uninstall InvoiceTotally: removes the program and its shortcuts. Your data (companies, invoices, backups in
// %LOCALAPPDATA%\InvoiceTotally) is removed only if you choose so.
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

const createNoWindow = 0x08000000

func hidden(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
	return c
}
func ask(text string, flags uintptr) int {
	u := syscall.NewLazyDLL("user32.dll")
	p := u.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	h, _ := syscall.UTF16PtrFromString("Uninstall Vipul Workplace")
	r, _, _ := p.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(h)), flags)
	return int(r)
}

func main() {
	r := ask("Uninstall Vipul Workplace?\n\nYes = remove the program but KEEP your data (companies, invoices, backups).\nNo = remove the program AND all your Vipul Workplace data on this PC.\nCancel = do nothing.", 0x23|0x30)
	if r == 2 {
		return
	}
	removeData := r == 7
	if removeData && ask("Delete all Vipul Workplace data on this PC? This can't be undone (entries already in Tally stay in Tally).", 0x34) != 6 {
		return
	}
	local := os.Getenv("LOCALAPPDATA")
	data := filepath.Join(local, "InvoiceTotally")
	// stop the app
	key, _ := os.ReadFile(filepath.Join(data, "window.key"))
	req, _ := http.NewRequest("POST", "http://127.0.0.1:47821/api/quit", nil)
	req.Header.Set("x-it-key", strings.TrimSpace(string(key)))
	c := http.Client{Timeout: 2 * time.Second}
	if resp, err := c.Do(req); err == nil {
		resp.Body.Close()
		time.Sleep(3 * time.Second)
	}
	self, _ := os.Executable()
	dir := filepath.Dir(self)
	programs := filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs")
	for _, p := range []string{filepath.Join(os.Getenv("USERPROFILE"), "Desktop", "InvoiceTotally.lnk"), filepath.Join(programs, "InvoiceTotally.lnk"), filepath.Join(os.Getenv("USERPROFILE"), "Desktop", "Vipul Workplace.lnk"), filepath.Join(programs, "Vipul Workplace.lnk")} {
		_ = os.Remove(p)
	}
	_ = hidden("reg.exe", "delete", `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InvoiceTotally`, "/f").Run()
	targets := `rmdir /s /q "` + strings.ReplaceAll(dir, `"`, `""`) + `"`
	if removeData {
		targets += ` & rmdir /s /q "` + strings.ReplaceAll(data, `"`, `""`) + `"`
	}
	_ = hidden("cmd.exe", "/C", fmt.Sprintf(`ping 127.0.0.1 -n 3 >nul & %s`, targets)).Start()
}
