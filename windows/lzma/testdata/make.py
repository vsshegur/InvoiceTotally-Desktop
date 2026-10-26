#!/usr/bin/env python3
"""Makes the small fixtures for lzma_test.go: <name>.raw and <name>.lzma (xz's lzma_alone format). Needs python3 only."""
import lzma, random, os
here = os.path.dirname(os.path.abspath(__file__))
rnd = random.Random(7)
words = "invoice ledger stock item purchase taxable value GST CGST SGST rate dozen pieces party bill voucher".split()
text = " ".join(rnd.choice(words) + str(rnd.randint(0, 99)) for _ in range(6000)).encode()
binary = bytes(rnd.getrandbits(8) if rnd.random() < .3 else (i * 7) & 0xFF for i in range(40000))
runs = (b"A" * 5000 + b"xyz" * 3000 + bytes(range(256)) * 20) * 3
cases = {"text": text, "binary": binary, "runs": runs, "tiny": b"x", "empty": b""}
for name, data in cases.items():
    open(os.path.join(here, name + ".raw"), "wb").write(data)
    for tag, flt in (("", {"id": lzma.FILTER_LZMA1, "preset": 9}), ("_lc0pb0", {"id": lzma.FILTER_LZMA1, "preset": 6, "lc": 0, "lp": 0, "pb": 0}), ("_lp2", {"id": lzma.FILTER_LZMA1, "preset": 6, "lc": 2, "lp": 2, "pb": 2})):
        c = lzma.compress(data, format=lzma.FORMAT_ALONE, filters=[flt])
        open(os.path.join(here, name + tag + ".lzma"), "wb").write(c)          # size unknown, end marker
        if tag == "":
            known = c[:5] + len(data).to_bytes(8, "little") + c[13:]
            open(os.path.join(here, name + "_known.lzma"), "wb").write(known)  # size in the header
