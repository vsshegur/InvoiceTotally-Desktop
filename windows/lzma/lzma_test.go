package lzma

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLZMAFixtures(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.lzma")
	if len(files) == 0 {
		t.Fatal("no fixtures")
	}
	for _, f := range files {
		base := strings.TrimSuffix(filepath.Base(f), ".lzma")
		name := strings.SplitN(base, "_", 2)[0]
		want, err := os.ReadFile("testdata/" + name + ".raw")
		if err != nil {
			t.Fatal(err)
		}
		src, _ := os.ReadFile(f)
		got, err := Decode(src, 1<<30)
		if err != nil {
			t.Errorf("%s: %v", base, err)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s: output differs (%d bytes, want %d)", base, len(got), len(want))
		}
	}
}

func TestLZMADamaged(t *testing.T) {
	src, _ := os.ReadFile("testdata/text.lzma")
	// cut short, flipped bytes and a lying header must give an error or different bytes, never a crash
	if _, err := Decode(src[:len(src)/2], 1<<30); err == nil {
		t.Error("truncated data was accepted")
	}
	for i := 20; i < len(src); i += 97 {
		bad := append([]byte(nil), src...)
		bad[i] ^= 0xFF
		_, _ = Decode(bad, 1<<30)
	}
	if _, err := Decode(src[:10], 1<<30); err == nil {
		t.Error("tiny input accepted")
	}
	big := append([]byte(nil), src...)
	for i := 5; i < 13; i++ {
		big[i] = 0x7F
	}
	if _, err := Decode(big, 1<<20); err == nil {
		t.Error("absurd size accepted")
	}
}

// LZMA_BIG=path/to/file.raw with path.lzma beside it: a real, large file (the Node runtime) round-trips.
func TestLZMABig(t *testing.T) {
	p := os.Getenv("LZMA_BIG")
	if p == "" {
		t.Skip("set LZMA_BIG to try a large file")
	}
	want, _ := os.ReadFile(p)
	src, _ := os.ReadFile(p + ".lzma")
	got, err := Decode(src, 1<<31)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("big file: err=%v equal=%v", err, bytes.Equal(got, want))
	}
}

// After windows/build.sh: the real payload unpacks to a zip that holds the runtime and the app.
func TestPayloadIfBuilt(t *testing.T) {
	src, err := os.ReadFile("../setup/payload.lzma")
	if err != nil {
		t.Skip("no payload.lzma (run windows/build.sh first)")
	}
	raw, err := Decode(src, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, f := range zr.File {
		have[f.Name] = true
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, rc); err != nil { // reading checks each file's CRC
			t.Fatalf("%s: %v", f.Name, err)
		}
		rc.Close()
	}
	for _, n := range []string{"runtime/node.exe", "InvoiceTotally.exe", "Uninstall InvoiceTotally.exe", "app/desktop/main.mjs", "app/public/index.html"} {
		if !have[n] {
			t.Errorf("payload lacks %s", n)
		}
	}
}
