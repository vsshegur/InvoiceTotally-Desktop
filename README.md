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

## Invoice upload date checks, deletion and Smart Matching (v3.7.2)

**Upload Invoices** now asks whether you want a **specific month and year**
(defaults to the current month; select e.g. May 2026) or **Regular mixed
invoices**. In monthly mode, invoices recognized by AI with a different
month/year are moved into **Have a look** and cannot be queued to Tally until
the date is corrected to the selected month. Regular uploads allow invoices
from different months within the financial year of the upload (April–March).
Outside-FY dates, future-dated invoices and handwritten invoices require a
manual date verification.

The app **does not replace** an AI-extracted date automatically. Example:
a handwritten May 2026 invoice misread as May 2020 is shown in **Have a
look**. Open the original image, correct the date and tick **I inspected
the original invoice and verified its date/year**, then Save. Until this
confirmation, the invoice is blocked from Tally posting even if the party,
stock and tax mappings are otherwise complete. A deliberate historic
invoice in *Regular mixed invoices* can be posted after explicit manual
confirmation. Date checks also apply retrospectively to older invoice batches;
their original upload date determines the financial-year window.

**Delete batch** now works from the batch page. Local draft invoices,
pages and files are removed after confirmation; **previously created Tally
vouchers are never modified**. If a voucher is actively being sent to Tally,
deletion is refused until the result is known. Tally job outcomes remain
available in the Tally log. Previously-used AI reading credits are not refunded by deletion.

**Smart Matching** now remembers the confirmed supplier, per-supplier
stock-item, per-supplier/item account ledger, charges, and GST tax-ledger
mappings whenever Tally confirms that a newly created purchase/sales voucher
was saved. These remembered mappings help match future invoices with the same
supplier and item; they are scoped per company. Earlier manual matching
decisions take priority and are never silently overwritten. Rejected, merely
queued or draft invoices do not teach Smart Matching. The Smart Matching tab
shows how many mappings were learned from confirmed Tally postings.

To reuse mappings from invoices **already posted in older versions**, open
**Smart Matching → Learn from earlier Tally-posted invoices**. The action
reads locally confirmed completed Tally import jobs in batches of up to 100.
Only invoices with a completed job and an explicit **Created** result qualify.
It does not modify Tally or learn from invoices merely marked as synced.
Click again if more earlier invoices remain; existing manual mappings are
always preserved.

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

## Offline Meesho / Flipkart / Amazon → Tally (v3.4, Amazon added in 3.9.0)

Open a company's **E-Commerce → Tally** tab. Choose the month and upload **.xlsx** reports:
- **Meesho:** TCS Sales and TCS Sales Return workbooks; optional invoice-summary workbook.
- **Flipkart:** the marketplace's GSTR-1 GST workbook with sections 7(A)(2), 7(B)(2) and/or 5B.
- **Amazon:** Seller Central's GST report(s) — `GST_MTR_B2B` and/or `GST_MTR_B2C` (Reports →
  Tax Document Library → GST reports). Upload at least one; most sellers only need B2C.
  The e-commerce operator GSTIN is derived from Amazon Seller Services Pvt Ltd's PAN
  (confirmed against its published state-wise GSTINs), the same way Flipkart's and Meesho's
  operator GSTIN are derived. **Validate the first Amazon import against a real report and
  your GSTR-1 before relying on it for filing** — the column layout is taken from Amazon's own
  published report field names but has not been tested against a live downloaded file.

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
- **Safe Tally posting and recovery:** Posting remains create-only, and existing Tally
  records are checked before invoices and bank entries are sent. Failed or uncertain
  jobs appear in the **Tally log**; unknown outcomes must be verified in Tally
  before retrying. The separate Posting Audit module is not included.
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

## Accounting Workplace update (v3.8.0)

This release includes read-only bank reconciliation, reviewed bank ledger mapping,
manual Meesho/Flipkart settlement previews with bank payout suggestions, a unified
Accounting Action Center, inter-company ledger comparison, and startup diagnostics.
The **Outstandings**, **GST Invoice Links**, and **Posting Audit** modules were
removed from the screens, APIs and schema definitions. Core GSTR-2B reconciliation,
Tally duplicate checking and existing Tally job records remain supported. Party-ledger
bank postings now require an explicit **On Account** approval rather than reading
bill-wise outstanding snapshots. All existing local accounting databases are left
intact, including any older records created by previous versions. Reconciliation
screens do not create or modify Tally entries. Review the installer and test with a
separate Tally company before using new accounting workflows on production books.

## Bug fixes (v3.9.0)

Alongside the Amazon addition above, this release fixes two correctness issues found
in an audit of the recent accounting modules:

- **GSTR-2B purchase "check logic" reconciliation (`gst-control.js`)**: an unmapped
  freight, discount or other-charge ledger line on a **purchase** voucher (no saved
  GST ledger rule) was silently dropped from the taxable total instead of being added
  back, understating purchase-side GST/ITC figures with no warning shown. Purchases
  now follow the same name-pattern recognition and unclassified-line review flagging
  that sales already had.
- **Backup restore leaving a GSTR-2B purchase voucher stuck (`safe-backup.mjs`)**: when
  restoring a backup that had a GSTR-2B purchase posting mid-flight, the safety logic
  that freezes unverifiable in-flight postings (added for invoices/bank/e-commerce)
  had never been extended to the newer GSTR-2B purchase posting job type. The job was
  still marked failed, but the voucher itself was left showing "queued" forever with
  no job driving it. It's now marked "uncertain" (the same "verify in Tally before any
  manual retry" state e-commerce already used) so it surfaces for review instead of
  getting stuck silently.

## Version 4.0.0 — redesign, Outstanding & ageing, sharing, Inter-company fixes

- **New navigation.** Each company has a left sidebar grouped by what you are doing: Overview and Action Center; *Post to Tally* (Invoices, Bank statements, E-Commerce); *Reconcile* (GSTR-2B, GST reconciliation, Inter-company); *Parties & bills* (Outstanding & ageing, Masters, Smart matching); *System* (Tally log, Settings, **Diagnostics last**). Every page has the same title/description header. On narrow windows the sidebar becomes a scrolling strip.
- **Outstanding & ageing** (also under *Masters → Outstanding & share*). Read live from Tally's own Bills Receivable / Bills Payable reports; if a Tally setup does not answer those it falls back to each party's bill allocations, then to ledger balances. A "What Tally answered" panel shows which step worked, and parties whose bills do not add up to their ledger balance are flagged. Tick/untick parties and individual bills; filter by group, party or "as on" date.
- **Share by WhatsApp or PDF**, per party, for the ticked parties, or one summary message per group. WhatsApp opens with the message ready (a link cannot attach a file, so download the PDF and attach it in the chat). Numbers are stored on this PC only (not in Tally).
- **Inter-company matching** now pairs by reference ignoring prefixes, year tails and zero padding, allows ₹1 round-off, reads 10 days either side of the month so month-end entries are not reported as unmatched, ranks pairs so repeated amounts cannot steal each other's partner, and says why anything is left unpaired.
- Nothing in these features writes to Tally: all reads are Export requests.

## Version 4.1.0 — transaction-by-transaction bank matching, modern pickers, per-user features
- **Bank reconciliation, one transaction at a time.** "Go through transactions one by one" (or "One by one" on a recurring pattern) walks each statement line: the party is read from the narration (cheque clearing "By-Clearing NAME, Chq: …", UPI `…/DEBIT/NAME/…`, NEFT/IMPS), the party's *live* open bills are read from Tally, bills named in the narration or equal to the amount are pre-ticked, "Fill oldest bills first" is one click, and the rest is saved On Account. Nothing is posted from this screen.
- **Searchable ledger boxes.** Every long dropdown (≥10 options) becomes a type-to-search box with full keyboard control (↑ ↓ Enter Esc). The ledger list now loads every master, not the first 200.
- **New calendar and month picker** (typed dates too: `25/10/2026`, `Oct 2026`).
- **Invoice upload: several months.** Choose any set of months (or a whole FY) as the allowed invoice months.
- **Inter-company: month or whole financial year** (1 Apr – 31 Mar).
- **Outstanding & ageing:** sort by party name, bills, oldest or pending (click again to reverse). The WhatsApp group message now lists every party's bills.
- **GST reconciliation panel redesigned:** a stepper, Tally figure cards, portal figures in a collapsible section and a pass/fail pill on each comparison.
- **Admin: per-user features.** Switch Invoices, Bank, E-Commerce, GSTR-2B, GST reconciliation, Inter-company, Outstanding and WhatsApp/PDF sharing on or off for each user. Switched-off features are hidden in the app and refused by the API. Everything is on by default; the admin is never restricted.
- **Settlements module removed.** The Settlements screen, its API and the Action Center item are gone. Existing saved settlement reports stay in the local database untouched.

## Version 4.2.0 — every module switchable per user, online check every 3 days
- **Fourteen on/off switches per user**, grouped: Invoices module, upload PDFs & photos, upload Excel/CSV, purchase vouchers from GSTR-2B, Bank statements, E-Commerce, GSTR-2B reconciliation, GST reconciliation, Inter-company, Outstanding & ageing, WhatsApp/PDF sharing, Masters, Smart matching, Action Center. *All on / All off* buttons on the user page. Examples: GSTR-2B only (everything else off); invoice upload via GSTR-2B only (turn off the Invoices module, keep *Purchase vouchers from GSTR-2B*); images only (turn off Excel/CSV). Switches are hidden in the app and refused by the API. (The Masters screen switch hides the screen; the ledger pick-lists inside other screens keep working.)
- **Must verify online every 3 days** (changeable 1–30 per user on the admin screen). The signed licence carries the date it was last checked; after the limit the app refuses to work until it reaches the service, and nothing is posted to Tally. A background check runs every 10 minutes while online, so users who simply have internet never notice. Turning the PC clock back to stretch the offline window is detected too. The app warns a day before it pauses. The admin account is exempt.

## Version 4.3.0 — dozen → pieces, discounts as a %, more permissions
- **Purchase bills in dozens.** All items are kept in PCS, so a line billed as `120 DZ @ ₹85` (DZ, DZN, DOZ, DOZEN…) is saved as `1,440 PCS @ ₹7.0833`; the amount the supplier billed never changes. When a bill prints both units (`120 DZ (1,440 pcs)`) the pieces figure is used and checked (12 × dozens), and the amount decides whether the rate was per dozen or per piece. If the numbers do not agree, or the amount fits neither reading, the line is left alone, flagged "Have a look", and the invoice cannot be posted until you tick *I checked these lines against the bill*. A name like "3060 WHITE 20 DOZ" with quantity 20 marked PCS is flagged too. Tally gets rates to 4 decimals.
- **Discount as a column, never a separate line.** A line such as "Less: Discount 1%" (in the item list or among the charges) is removed and its amount is spread over every item as the same discount %, with each line amount reduced proportionally (paise go to the largest line so the total is exact). Taxable value, GST and the invoice total follow. Item-wise discount plus a separate discount line is flagged for review. Applies to Purchase invoices only; sales invoices are untouched.
- Everything applied is listed on the invoice screen under *Adjusted for Tally*.
- **Admin: five action permissions** per user — create ledgers/stock items in Tally, delete invoices/batches/statements/companies, change company settings, backups & restore, download Tally XML — and a **Quick setup** list of roles (Accountant, GSTR-2B only, Invoice upload via GSTR-2B only, photos/PDFs only, Excel only, Bank only, Reports only).

## Version 4.3.1 — Add user shows every permission; one place for GSTR-2B upload
- The Invoices page already has **Upload invoices** and **Upload GSTR-2B**, so the separate sidebar item "GSTR-2B purchases" (and its Overview tile) is gone — it opened the same screen. A user who is allowed only the GSTR-2B upload still sees the Invoices item, with just that one card.
- Permission names in Admin now read: Invoice upload — photos & PDFs, Invoice upload — Excel / CSV, Invoice upload via GSTR-2B, GSTR-2B matching, Bank statements, E-Commerce → Tally, GST reconciliation, Inter-company matching, Outstanding & ageing (plus the rest).
- **Service update needed.** The permission list lives on the online service (`worker/licence.js` in vsshegur/invoicetotally). Until that is deployed, Add user shows a warning instead of the list. After deploying the service, the list appears in Add user and Edit user.

## Version 4.3.2 — bank entries that look alike but are different
- Before posting a bank line, the app compares it with Tally's bank entries of the same amount within seven days. Same day and same amount used to be held even when the cheque numbers were different. Now the **cheque number, bank sequence number and UTR/reference** in the two narrations are compared: a shared number means it is the same entry (held), numbers that all differ mean it is a different entry (posted). The hold stays only when there are no numbers to compare.
- A line that is held shows "Already posted earlier". Choosing **Post these after all** now remembers that you checked it, and the app no longer holds it again for the same reason (before, it was held again at once).

## Version 4.3.3 — admin panel redesigned around toggles
- **Add user** and **Edit user** are now sectioned forms (Who / Limits / AI / What this user can use) in a scrolling window with the buttons always in view. Every permission is a toggle with a one-line explanation, a per-group "all on / all off", a running "17 of 19 on", and the Quick setup roles.
- The permission list is built into the app, so it is always shown — even when the online service has not been updated. In that case a clear warning says the switches cannot be saved yet (nothing is silently lost), and Admin → Users no longer shows "All on" for what it cannot know.
- Switching **photos/PDFs** or **Excel** on also switches the Invoices module on; switching the Invoices module off switches both uploads off.
- The Users table shows "17 of 19 on" and lists the switched-off features on hover.

## Version 4.3.4 — smaller installer
- The installer is about **31 MB instead of 42 MB** (a quarter smaller). Almost all of it is the bundled Node.js runtime (87 MB on disk); the installer now packs everything as one LZMA stream instead of compressing file by file. The unpacker (`windows/lzma/lzma.go`) is a small decoder written from the public LZMA specification, so no outside code goes into the installer. Unpacking takes about 3 seconds longer.
- Tests: `cd windows && go test ./lzma` (small fixtures made by `windows/lzma/testdata/make.py`; `LZMA_BIG=<file>` checks a large file). CI runs them, then installs the built installer on a Windows machine and starts the app, as before.
- Nothing changes on the PC after installing: same files, same data folder.

## Version 4.3.5 — long bank narrations read correctly from PDF statements
- **Problem (Punjab National Bank and similar):** when a narration wraps over two or three lines and the date and amounts sit on the middle or last line of the cell, the wrapped lines above them were glued to the transaction *above*. Narrations came out scrambled, partly missing, or empty.
- **Fix:** the reader now uses the table's own row borders from the PDF to decide which lines belong to which row. If a PDF has no borders, it uses the larger gap at a row boundary (lines inside a cell are evenly spaced). Evenly spaced layouts without padding behave exactly as before.
- Pieces of one narration are joined sensibly: a UPI handle cut inside its domain (`…@a` + `xl/Pa` → `…@axl/Pa`), a cut after a dash or slash (`IMPS-` + `OUT/…`), and a long number cut over two lines (`…4526020000041` + `1`).
- A bare "Page No 1" line at the foot of a page is no longer added to the last narration.
- Checked on made-up PDF statements (borders and no borders; text at the top, middle or bottom of the cell; a 40-row, two-page statement) in a real browser: every narration exact. The same files read wrongly with 4.3.4.

## Version 4.3.6 — more than 40 invoice files in one upload
- Uploading 49 files ended with “Cannot read properties of undefined (reading 'id')”: the app has always accepted only 40 files per batch and dropped the rest silently, and the upload screen then crashed on file 41. One batch now takes up to 300 files, and if a batch ever can't take them all, the screen says so in plain words instead.
- (The 4.3.4 smaller installer was not the cause: it contains exactly the same 64 files as 4.3.0, checked file by file.)

## Version 4.3.7 — tax now calculates for every invoice, and stays after you correct one
- **Problem:** in a batch of more than 40 invoices, the Tax step's *Recalculate* only ever worked on the first 40, so the rest stayed “not calculated” however often it was pressed. Saving a corrected invoice also threw away its tax, sending it straight back to “calculate tax” (the invoice page said “Lines, taxes and total add up” while the batch still said “Needs fixing: calculate tax”).
- **Fix:** *Recalculate* now covers every invoice in the batch. Saving an invoice recalculates its tax immediately, keeping the tax ledgers you had already chosen.
- If a batch already shows “not calculated”, update and press *Recalculate* once.

## Version 4.4.0 — every GSTR-2B entry to Tally, GST-correct; bank statements from more banks; GSTIN check
**GSTR-2B → Tally**
- Every entry goes to Tally: invoices (B2B, e-commerce operator, amended) → Purchase; reverse charge (e.g. logistics) → Purchase with the supplier credited only the taxable value, plus an RCM GST journal (ITC and liability); supplier credit note → Debit Note; supplier debit note → Credit Note; ISD credit and import IGST → Journal; "ITC not available" → posted as in GSTR-2B and flagged in the narration. Entries already matched in reconciliation are not posted again.
- Taxable value goes to one purchase ledger per GST rate — `GSTR2B 5%`, `GSTR2B 12%`, `GSTR2B 18%`, `GSTR2B 28%`, `GSTR2B RCM 5%` … — created in Tally (Purchase Accounts) with that rate. An invoice with two rates is split across both. Each voucher carries the supplier's state, place of supply, GSTIN and registration type. This is what kept the old single `PURCHASE-GSTR2B` entries in Tally's "uncertain transactions".
- The rate comes from the file: the JSON per item, or the Excel's Rate column (an invoice the portal lists on two rows, one per rate, is now one entry — before, the second row was dropped as a "duplicate").
- Suppliers: "Create all missing suppliers" — Sundry Creditors, GSTIN, state from the GSTIN, registration Regular, bill-by-bill.
- All entries on one page (1000+), with filters, search, "select all ready", one Post; no 60-per-page or 120-per-post limit. One read of Tally's register serves a whole posting run.
- "Check posted are still in Tally": entries deleted in Tally become ready to post again.
- After posting, GSTR-2B reconciliation in the app matches every one of them (reverse charge: the purchase and its RCM journal together).

**Other**
- Amazon GST reports (MTR B2B / B2C) can be uploaded as CSV.
- Marketplace fee lines (fixed fee, ad service fee, shipping fee): choosing a ledger for one fee remembers that fee for that party only; "every line from this party" is a separate, clearly worded choice and never overrides a fee remembered on its own. Smart matching → Remembered choices lists everything the app fills in by itself, with Forget.
- Bank posting check: two entries of the same amount on the same day are told apart by their UPI / IMPS / NEFT reference or by the names in a bank narration (Kotak and others print the UPI reference without a "Ref" label).
- Bank statements: old Excel `.xls` files (real Excel 97–2003, and the HTML / text files banks name `.xls`) are read; more column names are recognised (Txn Posted Date, Narrative, Money In/Out, Amount in Rs, Transaction Type …); headings split over two rows are read as one.
- Invoices from images/PDF: a GSTIN check column — ✓ Verified (check digit OK and the same GSTIN is on your Tally ledger or in your GSTR-2B), ✓ Check digit OK · new, ⚠ differs from the Tally ledger, ✗ misread (with "did you mean" from the GSTINs you already have and a one-click fix on the Party step).

## Version 4.4.1 — no more "Uncertain transactions" in GSTR-3B
From Tally's own reasons (GSTR-3B → Uncertain Transactions):
- **"GST Registration Details of the Company are invalid or not specified"** — every voucher now names your GST registration as TallyPrime 3+ expects (`Maharashtra Registration`, GSTIN, state). If your Tally calls it something else, set it in Settings → "GST registration name in Tally".
- **"GST Registration Details of the Party are invalid or not specified"** — the party's registration type, GSTIN and state are sent, taken from the party's Tally ledger (where you verified the GSTIN), not from the AI's reading. Ledgers without a GSTIN go as Unregistered; Composition dealers as Composition (read with Import masters).
- **"Mismatch … Place of Supply (Solapur / Maharashtra)"** — place of supply is always a state: our state for purchases, the customer's for sales. A city read off the bill is ignored.
- **"Taxability Type is invalid or not specified"** (Flipkart / Meesho fee lines, expenses) — each such line carries Taxable, the GST rate and Goods/Services.
- GSTIN from Tally: when the bill's GSTIN is missing or misread, the matched ledger's GSTIN is used (the AI's reading is kept for reference); when the bill shows a *different valid* GSTIN, the invoice waits with a "Use GSTIN from Tally" button (Party step and invoice page).
- RCM at any rate: `GSTR2B RCM 5%`, `GSTR2B RCM 18%` …

## Version 4.5.0 — month-end, GST checks before posting, Tally ledger health, 180-day ITC, supplier follow-up; reorganised
- **Clean for GSTR-3B (before posting):** every bill is checked the way Tally's GSTR-3B checks it afterwards — party ledger GSTIN present and valid, registration type, state, IGST vs CGST + SGST by the party's state, CGST = SGST, tax ledgers under Duties & Taxes and the right head, stock items with a GST rate, unregistered parties charging GST. Errors hold the bill back with the exact fix; the invoice list shows "✓ Clean for GSTR-3B".
- **Tally ledger health:** parties without a GSTIN (with the GSTIN seen on their bills or in GSTR-2B), wrong state, registration type, the same GSTIN on two ledgers, GST tax ledgers not set as GST, fee/expense ledgers without GST details, stock items without GST rate/HSN — each with what to change in Tally. Import masters now also reads each ledger's GST details.
- **Month-end closing:** a checklist per month (GSTR-2B matched and posted, bills posted, GST checks, bank posted with nothing in Suspense, marketplace sales, suppliers asked, ledger health, Tally's uncertain transactions) and a GSTR-3B estimate: output tax, ITC from GSTR-2B, reverse charge, estimated cash to pay.
- **180-day ITC:** unpaid supplier bills 150+ days old from Tally, the date to pay by, and the GST at stake (from the app's bills or GSTR-2B).
- **Supplier follow-up:** invoices in your books that suppliers haven't filed, kept from each GSTR-2B match, with a WhatsApp message per supplier, "asked" tracking, and closing by themselves when a later GSTR-2B has them.
- **Reorganised:** Home (this month's closing, what to post, GST health, what needs you), and the sidebar by job: Post to Tally · GST · Parties & bills · Setup.
