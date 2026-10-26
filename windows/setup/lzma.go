package main

// A small LZMA ("lzma_alone", the .lzma file format) decoder, written from the public LZMA specification so the installer
// needs no outside code. The installer's payload is compressed with it (about a third smaller than zip's deflate).
// It decodes into one in-memory buffer, which also serves as the dictionary.

import (
	"encoding/binary"
	"errors"
)

var errLZMA = errors.New("lzma: data is damaged")

const (
	lzmaTop      = 1 << 24
	lzmaBitModel = 11
	lzmaProbInit = 1 << (lzmaBitModel - 1)
	lzmaMinLen   = 2
)

type lzmaRC struct {
	in   []byte
	pos  int
	rng  uint32
	code uint32
	bad  bool
}

func (r *lzmaRC) next() uint32 {
	if r.pos >= len(r.in) {
		r.bad = true
		return 0
	}
	b := r.in[r.pos]
	r.pos++
	return uint32(b)
}

func (r *lzmaRC) bit(p *uint16) uint32 {
	bound := (r.rng >> lzmaBitModel) * uint32(*p)
	var b uint32
	if r.code < bound {
		r.rng = bound
		*p += (1<<lzmaBitModel - *p) >> 5
	} else {
		r.rng -= bound
		r.code -= bound
		*p -= *p >> 5
		b = 1
	}
	if r.rng < lzmaTop {
		r.rng <<= 8
		r.code = r.code<<8 | r.next()
	}
	return b
}

func (r *lzmaRC) direct(n int) uint32 {
	var res uint32
	for ; n > 0; n-- {
		r.rng >>= 1
		r.code -= r.rng
		t := 0 - (r.code >> 31)
		r.code += r.rng & t
		if r.rng < lzmaTop {
			r.rng <<= 8
			r.code = r.code<<8 | r.next()
		}
		res = res<<1 + t + 1
	}
	return res
}

func (r *lzmaRC) tree(probs []uint16, n int) uint32 {
	m := uint32(1)
	for i := 0; i < n; i++ {
		m = m<<1 + r.bit(&probs[m])
	}
	return m - 1<<uint(n)
}

func (r *lzmaRC) treeRev(probs []uint16, n int) uint32 {
	m, sym := uint32(1), uint32(0)
	for i := 0; i < n; i++ {
		b := r.bit(&probs[m])
		m = m<<1 + b
		sym |= b << uint(i)
	}
	return sym
}

type lzmaLen struct {
	choice, choice2 uint16
	low, mid        [16][8]uint16
	high            [256]uint16
}

func newLzmaLen() *lzmaLen {
	l := &lzmaLen{choice: lzmaProbInit, choice2: lzmaProbInit}
	fill(l.high[:])
	for i := range l.low {
		fill(l.low[i][:])
		fill(l.mid[i][:])
	}
	return l
}

func fill(p []uint16) {
	for i := range p {
		p[i] = lzmaProbInit
	}
}

func (l *lzmaLen) decode(r *lzmaRC, posState uint32) uint32 {
	if r.bit(&l.choice) == 0 {
		return r.tree(l.low[posState][:], 3)
	}
	if r.bit(&l.choice2) == 0 {
		return 8 + r.tree(l.mid[posState][:], 3)
	}
	return 16 + r.tree(l.high[:], 8)
}

// lzmaDecode decodes a whole .lzma file (13-byte header, then the stream). The header may carry the real size or "unknown"
// (then the stream ends with an end marker). maxOut stops a damaged header from asking for absurd memory.
func lzmaDecode(src []byte, maxOut uint64) ([]byte, error) {
	if len(src) < 13+5 {
		return nil, errLZMA
	}
	props := uint32(src[0])
	if props >= 9*5*5 {
		return nil, errLZMA
	}
	lc, lp, pb := int(props%9), int((props/9)%5), int(props/45)
	size := binary.LittleEndian.Uint64(src[5:13])
	known := size != 1<<64-1
	if known && size > maxOut {
		return nil, errLZMA
	}
	var out []byte
	if known {
		out = make([]byte, 0, size)
	} else {
		out = make([]byte, 0, 1<<20)
	}

	rc := &lzmaRC{in: src[13:], rng: 0xFFFFFFFF}
	if rc.next() != 0 {
		return nil, errLZMA
	}
	for i := 0; i < 4; i++ {
		rc.code = rc.code<<8 | rc.next()
	}

	var (
		isMatch  [12 << 4]uint16
		isRep    [12]uint16
		isRepG0  [12]uint16
		isRepG1  [12]uint16
		isRepG2  [12]uint16
		isRep0L  [12 << 4]uint16
		posSlot  [4][64]uint16
		posDec   [1 + 128 - 14]uint16
		align    [16]uint16
		lit      = make([]uint16, 0x300<<uint(lc+lp))
		matchLen = newLzmaLen()
		repLen   = newLzmaLen()
	)
	fill(isMatch[:])
	fill(isRep[:])
	fill(isRepG0[:])
	fill(isRepG1[:])
	fill(isRepG2[:])
	fill(isRep0L[:])
	for i := range posSlot {
		fill(posSlot[i][:])
	}
	fill(posDec[:])
	fill(align[:])
	fill(lit)

	state := uint32(0)
	var rep0, rep1, rep2, rep3 uint32
	pbMask, lpMask := uint32(1)<<uint(pb)-1, uint32(1)<<uint(lp)-1

	for {
		if known && uint64(len(out)) >= size {
			break
		}
		if rc.bad {
			return nil, errLZMA
		}
		pos := uint32(len(out))
		posState := pos & pbMask

		if rc.bit(&isMatch[state<<4+posState]) == 0 {
			var prev uint32
			if len(out) > 0 {
				prev = uint32(out[len(out)-1])
			}
			probs := lit[0x300*(((pos&lpMask)<<uint(lc))+(prev>>uint(8-lc))):]
			sym := uint32(1)
			if state >= 7 {
				if uint32(len(out)) <= rep0 {
					return nil, errLZMA
				}
				match := uint32(out[len(out)-int(rep0)-1])
				for sym < 0x100 {
					mb := (match >> 7) & 1
					match <<= 1
					b := rc.bit(&probs[(1+mb)<<8+sym])
					sym = sym<<1 | b
					if mb != b {
						break
					}
				}
			}
			for sym < 0x100 {
				sym = sym<<1 | rc.bit(&probs[sym])
			}
			out = append(out, byte(sym))
			switch {
			case state < 4:
				state = 0
			case state < 10:
				state -= 3
			default:
				state -= 6
			}
			continue
		}

		var n uint32
		if rc.bit(&isRep[state]) != 0 {
			if len(out) == 0 {
				return nil, errLZMA
			}
			if rc.bit(&isRepG0[state]) == 0 {
				if rc.bit(&isRep0L[state<<4+posState]) == 0 {
					if uint32(len(out)) <= rep0 {
						return nil, errLZMA
					}
					if state < 7 {
						state = 9
					} else {
						state = 11
					}
					out = append(out, out[len(out)-int(rep0)-1])
					continue
				}
			} else {
				var dist uint32
				if rc.bit(&isRepG1[state]) == 0 {
					dist = rep1
				} else {
					if rc.bit(&isRepG2[state]) == 0 {
						dist = rep2
					} else {
						dist = rep3
						rep3 = rep2
					}
					rep2 = rep1
				}
				rep1 = rep0
				rep0 = dist
			}
			n = repLen.decode(rc, posState)
			if state < 7 {
				state = 8
			} else {
				state = 11
			}
		} else {
			rep3, rep2, rep1 = rep2, rep1, rep0
			n = matchLen.decode(rc, posState)
			if state < 7 {
				state = 7
			} else {
				state = 10
			}
			ls := n
			if ls > 3 {
				ls = 3
			}
			slot := rc.tree(posSlot[ls][:], 6)
			if slot < 4 {
				rep0 = slot
			} else {
				nd := int(slot>>1) - 1
				d := (2 | slot&1) << uint(nd)
				if slot < 14 {
					d += rc.treeRev(posDec[d-slot:], nd)
				} else {
					d += rc.direct(nd-4) << 4
					d += rc.treeRev(align[:], 4)
				}
				rep0 = d
			}
			if rep0 == 0xFFFFFFFF {
				break // end marker
			}
		}
		n += lzmaMinLen
		if uint64(rep0) >= uint64(len(out)) {
			return nil, errLZMA
		}
		if known && uint64(len(out))+uint64(n) > size {
			n = uint32(size - uint64(len(out)))
		}
		if uint64(len(out))+uint64(n) > maxOut {
			return nil, errLZMA
		}
		from := len(out) - int(rep0) - 1
		for i := 0; i < int(n); i++ {
			out = append(out, out[from+i])
		}
	}
	if known && uint64(len(out)) != size {
		return nil, errLZMA
	}
	return out, nil
}
