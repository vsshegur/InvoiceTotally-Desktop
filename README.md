# Vipul Workplace for Windows

One app on the PC that reads purchase and sales invoices with AI and posts them **straight into TallyPrime** —
no connector, no TallyBridge, no web app. Bank statements are read on the PC without any AI and posted to a
suspense ledger. GSTR-2B is checked against your purchases in Tally.

Everything stays on the PC except two things that go to the **InvoiceTotally service** (the existing Cloudflare
Worker, repo `vsshegur/invoicetotally`):

- **Reading an invoice** — the pages go to the service, which runs the AI and sends the data back. The AI keys
  are only on the service, never on a user's PC.
- **Who may use the app** — sign-in, each person's limits and credits. The admin is **vipulshegur@gmail.com**.

## Install

1. Download `Vipul-Workplace-<version>-Setup.exe` from this repository's **Releases** page and run it.
   It installs for your Windows user (no administrator needed) and puts **Vipul Workplace** on the desktop and in
   the Start menu. Windows may say *"Windows protected your PC"* because the installer isn't signed: press
   **More info → Run anyway**.
2. In TallyPrime: **F1 Help → Settings → Connectivity** → *TallyPrime acts as* **Both**, port **9000**.
   Keep the company open (several companies can be open with **Alt+F3**).
3. Open Vipul Workplace and press **Sign in with Google**. A window opens on the service's page; sign in with the
   Google account the admin added. The app stays signed in on this PC.
4. **Add company** — pick it from the companies open in Tally. Its ledgers, groups, units and stock items are read
   from Tally straight away.

Updating: run the newer Setup — your data is kept. The app shows a notice when a newer version is on Releases.
Uninstall from *Settings → Apps* or the Start menu; you choose whether to keep your data.

Your data remains in the legacy `%LOCALAPPDATA%\InvoiceTotally` folder (intentionally unchanged so existing invoices, companies and backups survive the rename) (one SQLite file). A copy is saved **once a day** (last 14
kept) — choose a Google Drive or OneDrive folder under **⚙ → This PC** so a copy is also online.

## What each person can do (set by the admin)

The admin opens **★ Admin** in the app:

| Setting | What it does |
|---|---|
| **Add user** | Their Google email. Only added people can sign in. |
| **Companies allowed** | How many companies they can add. The service counts them, so reinstalling doesn't reset it. |
| **Posting to Tally** | *Allowed*, or *Blocked* — they can read and review but nothing goes into Tally. |
| **Invoice credits** | One is used for each invoice read. Reading stops at zero; invoices already read can still be posted. |
| **Statement credits** | One is used for each bank statement saved. |
| **AI** | Which of the four AIs they may use (below). Each company then puts the allowed ones in order. |
| **Switch off** | Signs them out on every PC at once. |

Credits are added by the admin (for example after a UPI payment) with a note; every use is in the user's history,
with the AI cost of each invoice.

## The four AIs

| AI | Cost | Good for |
|---|---|---|
| **Gemini Flash-Lite (free)** | free key, limited reads per day | clear printed invoices |
| **Groq (free)** | free key; about 25 invoices a day, at most 3 pages per invoice | clear printed invoices |
| **Gemini Flash** | paid key, about ₹1 per invoice | most invoices |
| **Claude** | paid, more per invoice | handwritten and difficult bills |

### Several AIs, in priority order

In each company's **Settings**, tick the AIs to use (from the ones the admin allowed) and put them in order with ▲ ▼:

- The **first** one reads every invoice.
- When a bill is **handwritten**, or its totals don't add up, the **next** one reads it again and the better reading
  is kept — for example Groq or Gemini Flash-Lite (free) first, then Gemini Flash or Claude for the hard bills.
- When one is out of its daily limit, has no key on the service, or can't take that many pages (Groq: 3), the next
  one reads instead.

New companies get every allowed AI, free ones first. **Test the ticked AIs** checks each one without using a credit.
One invoice credit is used per invoice, however many AIs read it.

The keys are set only on the service (Cloudflare → the `invoicetotally` Worker → Settings → Variables and Secrets):
`GEMINI_API_KEY` (free), `GROQ_API_KEY` (free, console.groq.com), `GEMINI_PAID_API_KEY`, `ANTHROPIC_API_KEY`.
Nothing secret is kept on a PC.

## Bank statements

Download the statement from net banking as **Excel, CSV or PDF** (a password-protected PDF is fine — the app asks
for the password). It is read on the PC: the column headings are found, every row is checked against the running
balance, and you see the totals before saving. Statements that print the date only on a day's first entry and the
balance only on its last (common at co-operative banks) are read in full; the entries in between are checked through
the next printed balance. When the bank prints its own count of debits and credits, the app checks it read the same
number. If a bank's layout isn't recognised, you say once which column is which and it is remembered for that bank
account.

Every transaction is posted to the **suspense ledger** you choose — money in as a **Receipt**, money out as a
**Payment**, with the bank's narration and cheque/reference number as the narration. You then move each entry from
Suspense to the right ledger in Tally. A transaction already posted from an earlier statement is marked
*Posted earlier* and not posted again. Scanned or photographed statements can't be read (that would need AI).

## GSTR-2B review update (v3.7.1)

**Posting a ready document:** on the GSTR-2B purchase review page, click
**Post Purchase** or **Post Debit Note** beside an eligible row, review the
confirmation and send it to Tally. For bulk posting, tick the ready rows,
verify both review checkboxes in the sticky posting bar, and click **Post N
selected to Tally**. A row marked **ready** is not yet posted; **synced** means
Tally confirmed creation. Previously selected checkboxes and confirmations
remain selected while refreshing the screen.

**Missing supplier GSTIN in Tally masters:** this means the imported
creditor ledger is absent or does not have the GSTR-2B supplier's GSTIN.
For a completely new supplier, click **Create supplier in Tally** beside that
row (explicit approval required). The app queues a ledger under Sundry
Creditors using the supplier name and GSTIN from the return. When Tally
confirms creation, refresh the page: unresolved review rows auto-match by
GSTIN. If a ledger with that name already exists but lacks the correct
GSTIN, update the **existing** ledger in Tally and click **Import masters**.
The app must not create a duplicate with the same name.

**Supplier credit notes:** original GSTR-2B CDNR credit notes become **Debit
Notes** in the buyer's books: debit supplier, credit `PURCHASE-GSTR2B`,
credit/reverse mapped Input GST, and balance Round Off. For e-commerce
(ECO/ECOA) and amended credit-note documents (CDNRA), use **Record as Debit
Note** only when the original supplier-issued credit note confirms that
the entry is a real credit, not a normal invoice or merely an amendment.
Amended documents require an additional explicit confirmation. The specific
Flipkart document `FKCKA27000482834` can be reviewed/classified **without
re-uploading** a previously prepared batch. Other e-commerce or amended
documents stay blocked until explicitly verified. No stock movements are
created.

**Important:** Debit Note may need enabling in the target TallyPrime company.
No automatic bill-wise allocation to an original supplier invoice is made
because GSTR-2B does not contain a verified original bill reference for every
credit. Verify original-document treatment, GST reversal, supplier balance and
reference allocation in Tally, particularly across earlier tax years. Each
post is checked against Tally live to stop duplicate creates; uncertain
outcomes require a fresh recheck.

## GSTR-2B invoices → Tally Purchases (v3.7.0)

Open a company's **Invoices** tab. It now has **1. Upload Invoices** (the original PDF/photo/Excel flow)
and **2. Upload GSTR-2B**. The second option reads the official GST portal Excel or JSON
locally or reuses a previously imported GSTR-2B return. It prepares individual **Purchase**
vouchers in Tally's **Accounting Voucher View**, without stock items or guessed quantities.

- The purchase base always uses the exact ledger **`PURCHASE-GSTR2B`**, under **Purchase Accounts**.
  If missing, there is an explicitly approved *Create Ledger* action; wait for its Tally import.
- A supplier must have a ledger under Sundry Creditors with the same GSTIN as the portal invoice.
  Other supplier ledgers must be corrected in Tally and re-imported (or chosen if more than one matches).
- Input IGST/CGST/SGST/Cess and Round Off each require an existing, explicitly mapped Tally ledger.
  Supplier invoice number appears in **Reference** and bill allocation. The app generates a
  separate stable Tally voucher number, and uses the **supplier invoice date** even when the
  GSTR-2B filing month is later.
- The preview shows the Purchase debit, Input GST debits, round off, supplier credit and total.
  **Select** the invoices, tick both review confirmations, and approve posting. Up to 120 vouchers
  can be queued per click. Posting is available only to licensed users with Tally write permission.
- Matching/ineligible invoices, amendments, notes, reverse-charge and unusual/unbalanced amounts
  are **blocked for review**, not silently turned into ordinary Purchase entries.
- Every queued voucher is checked **again against live Tally purchases** before sending XML,
  including supplier invoice reference, GSTIN and voucher number. A duplicate is not posted.
  An uncertain Tally response or restart requires a fresh *Recheck* and explicit approval
  before retrying. No posting is automatic on upload.

The importer neither creates stock quantities nor infers freight/discount/HSN from GSTR-2B.
If your accounts depend on inventory or invoice-specific charges, use **Upload Invoices** instead.
Always verify tax/accounting classification and original bills before posting.

## Offline Meesho / Flipkart → Tally (v3.4)

Open a company's **E-Commerce → Tally** tab. Choose the month and upload **.xlsx** reports:
- **Meesho:** TCS Sales and TCS Sales Return workbooks; optional invoice-summary workbook.
- **Flipkart:** the marketplace's GSTR-1 GST workbook with sections 7(A)(2), 7(B)(2) and/or 5B.

The existing local Excel decoder and the PackPilot GSTR-1 grouping calculations handle the files
**on the same PC**, without a conversion/AI service, Firebase, Cloudflare or invoice credits. The
selected company's GSTIN must match the reports. The app uses one monthly voucher for each
**marketplace + customer state + GST rate**, with returns netted against sales. A negative net group
uses a Credit Note. Financial-year, state and GST-rate based voucher numbers remain stable
regardless of the Excel row order.

The review page shows taxable value, tax, GST total, HSN summary and the exact voucher
numbers. First import Tally masters and **map the real Tally party, sales, output GST and round-off
ledgers**. Accounting mode creates no stock movements; an optional Meesho inventory mode
requires explicitly mapped existing **HSN-correct, piece-count stock items**, and may affect Tally
stock balances. Flipkart's summarized GST workbook has no item quantities so it uses
accounting vouchers. If the ledgers/stock masters are missing, create or configure them in
Tally first, import masters again and then review.

The posting button requires review confirmation. **Each voucher is checked against Tally's
existing voucher numbers immediately before the write**. A matching number is skipped;
failed/uncertain postings are not automatically retried. If Tally stops answering after a write
might have reached it, check in Tally before trying anything again. Previous PackPilot XML
imports use **different voucher numbers**, so manually verify that the month has not already
been booked through PackPilot or another workflow.

This is **monthly sales/GST accounting**, not order-by-order booking, settlement reconciliation,
commission booking or GSTR-1 filing. Original files are read locally; the local database keeps
the consolidated vouchers and posting history, not the uploaded workbook bytes. Conversion
does not require internet; the existing desktop sign-in and **30-day cached licence** rules still
apply. The connection to TallyPrime is local on port 9000.

## Accounting controls (v3.5.0)

The five new optional accounting controls use local SQLite and read-only Tally XML requests.
No external AI/API is required for these features; the existing app licence and invoice AI
service are unchanged. Financial totals **must** be checked against actual Tally company
configuration and official GST returns before relying on them.

- **GST reconciliation:** Per-company **GST Reconciliation** tab compares GSTR-1 figures,
  Tally outward Sales/Credit Note records, GSTR-3B taxable/output GST and GSTR-2B input
  credit from the existing GST tool. Import supported official-style GSTR-1/3B JSON entirely
  offline, or enter portal summary amounts manually. Supported JSON sections include B2B,
  B2CL, B2CS, notes and exports; invoice-level matching checks registered-buyer GSTIN,
  invoice number, taxable and GST amounts. Unexpected JSON layouts must be entered
  manually, not guessed. This is a review tool, **not return filing**. Tally ledger-based
  totals can leave nonstandard ledgers and journals unclassified; accountant review required.
- **Smart Matching:** A company-specific tab ranks existing ledgers and stock-item masters,
  highlights HSN/GSTIN/GST-rate/units differences and lets the user explicitly remember
  safe mappings. Downloads per-company mapping CSV for offline review. It never creates
  masters or posts Tally vouchers automatically.
- **Multi-company dashboard:** The Companies page links to the multi-company accounting
  dashboard. Click **Read Tally balances** per company for the latest read-only ledger
  closing balance snapshot. Displays company name, connection summary, bank/cash,
  receivable/payable, Sales/Purchase and Duties/Taxes *net ledger balances* and local
  workflow counts, with snapshot time. These are not an official balance sheet/P&L,
  calculated payable tax, real-time bank balances or cash flow.
- **Posting audit & safe recovery:** The per-company **Posting Audit** tab displays
  local tamper-evident SHA-256 hash-chain records for Tally posting attempts, successes,
  rejections, duplicate prevention and uncertain outcomes; exports a CSV. Raw XML
  and invoice images are not copied into audit records. A broken chain displays a warning.
  Auditing starts in this version; older history cannot be recreated. Retry unknown
  results only after manually checking the source vouchers in Tally.
- **Verified backups / restore:** **Account → This PC** displays dated backups with
  SQLite integrity and SHA-256 verification. Existing daily backups retain 14 versions.
  Admins can optionally make *portable password-encrypted AES-256-GCM backups* with a
  locally derived passphrase, no cloud service and no stored password. No one can recover
  the backup without the passphrase. Restoring requires two confirmations and takes
  effect only after a full restart; a pre-restore SQLite rollback copy is kept. **All
  pending/in-flight Tally posting jobs from the restored snapshot are frozen** so an
  old backup cannot silently replay already-posted entries. Reconfirm them in Tally.
  If using a removable/network synced backup folder, keep its files accessible
  until the next application start after requesting restore.

### Scope / validation

Windows/Linux automated tests exercise GST comparison, mapping safety, audit integrity,
AES backup encryption/decryption, restoring a database and mock Tally. This does **not**
replace verifying nonstandard GST portal exports or real TallyPrime ledgers and GST
configuration on a dedicated test company before using results in production.

## Safety

- The app window is the only thing that can use the app: it is served on `localhost` only, and every request
  needs a key that only the desktop icon passes to the window.
- Writing to Tally goes through one checked path: exactly one new **Purchase, Sales, Receipt, Payment or Contra**
  voucher, or one new ledger, stock item or unit, for the right company, marked *Create*. Nothing in Tally is ever
  altered or deleted by this app.
- If the app is closed while posting, that entry is marked "check in Tally" rather than posted twice.

## How it is built

```
desktop/   main.mjs   — the app on the PC: serves the window, reads in the background, runs Tally jobs, backups
           tally.mjs  — TallyPrime on port 9000: reads, the one checked write path, reply parsing
           runner.mjs — the Tally job queue (waits while Tally or the company isn't open)
           licence.mjs— sign-in, the signed licence, calls to the service
engine/    the invoice engine (matching, tax, vouchers, GSTR-2B, bank) on SQLite
public/    the screens (plain JavaScript, no build step)
service/   licence.js — the service side (deployed as worker/licence.js in vsshegur/invoicetotally)
windows/   launcher (legacy internal filename InvoiceTotally.exe), Setup and Uninstall, build.sh
tests/     node --test tests/*.test.mjs — the whole app with a stand-in service and a stand-in TallyPrime
```

The installer bundles Node.js (the runtime) — nothing else needs installing. GitHub Actions builds it on every
push to `main`, installs it on a Windows machine, starts it, and attaches `Vipul-Workplace-<version>-Setup.exe` to
the release.

Try it without Windows or Tally: `node tests/fake-service.mjs 8790`, `python3 tests/mock_tally.py 9100`, then
`IT_SERVICE=http://127.0.0.1:8790 TALLY_URL=http://127.0.0.1:9100 IT_PRINT_KEY=1 node desktop/main.mjs` and open
the address it prints.
