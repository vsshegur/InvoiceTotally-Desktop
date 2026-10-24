# Accounting Workplace preview (v3.8.0-preview.1)

**Status: Test-only build. Not production-certified.** The stable v3.7.2 release on `main` is unchanged. All eight requested feature areas have initial modules, but settlement journal posting, Tally-native BRS clearing dates, and fully automated bill allocation are **not** enabled. They require testing against a real TallyPrime company and verified marketplace/bank samples.

## Test installation
1. Use the `vipul-workplace-accounting-preview` artifact from the successful **PR #24** GitHub Actions Windows run. Do not confuse it with the stable 3.7.2 release installer.
2. **Use a separate Windows user/profile or test PC** with a dedicated Tally test company. This installer preserves existing data and migrates it; avoid opening it against a production Tally company before verification.
3. Make a verified encrypted backup first. On an existing local SQLite database, the preview automatically makes a consistent `.before-accounting-upgrade-*.sqlite` copy before schema initialization (same data directory, requires enough disk space). Database upgrade is transactional; backups are not a substitute for off-PC recovery.
4. Open both Tally companies where needed. TallyPrime must be reachable on its configured port (default 9000).
5. No new import is started by the reconciliation screens; bank posting still requires manual review and confirmation.
6. To undo a preview installation, reinstall a compatible prior release and restore the corresponding pre-upgrade/verified SQLite backup as needed. Do not assume older builds can safely read newer schema versions.

## What is included
- **Bank Reconciliation:** load a bank statement, choose **Reconcile against Tally**, compare with live Tally bank-voucher entries. Only a unique reference, amount, direction and date-window match is confirmed. Date/amount-only matches remain suggestions. Tally's native BRS clearing dates are not changed.
- **Smart Bank Accounting:** select an unposted bank line and an existing master ledger, optionally remember the manually approved narration key. Party ledgers require an exact bill reference from a recent outstanding snapshot or an explicit **On Account** decision. The existing bank voucher generator is reused.
- **Bank duplicate protection:** every bank posting first checks the live Tally bank register. Same-day, same-direction and same-amount entries are held for manual review. Missing Tally or uncertainty fails closed; errors are not automatically retried. Releasing uncertain entries requires a new live check plus explicit confirmation.
- **Marketplace Settlement Reconciliation:** import an actual settlement workbook, choose sheet/header/columns, and specify whether payouts are per-row or repeated settlement totals. See gross, returns, commissions, shipping, TCS, TDS, deductions, expected payout and actual payout per settlement. Match candidate bank deposits using existing bank statements. All settlement features are **read-only**: no new Journals, clearing, fees, or payment vouchers.
- **Accounting Action Center:** a company-specific inbox of local invoice, bank, GST and Tally exceptions. This is an exception overview, not a declaration that a month is fully reconciled.
- **Outstandings:** refresh Tally Bills Receivable and Bills Payable, see bill-wise due dates and overdue totals. Review ledger/bill mapping before banking.
- **GSTR-2B source links:** review portal documents against previously uploaded source invoices, check supplier GSTIN, invoice number, original date and value. Linking is local evidence only. It does not verify tax eligibility or post a purchase voucher.
- **Inter-company reconciliation:** open both companies and select the reciprocal ledgers for the month. The app reads both Tally ledger voucher lists and suggests reference-backed, opposite-sign reciprocal entries; no changes in either company's books.
- **Startup Diagnostics:** local database integrity check, essential UI file check, page-loading fallback and diagnostic screen. Windows launcher failure logs remain in `%LOCALAPPDATA%\InvoiceTotally\logs`.

## Boundaries and known limitations
- Requires a matching Tally master import; read-only ledger exports and bills depend on the configured TallyPrime company's enabled reports, voucher types and particular Tally version.
- Bank duplicate protection prefers a false positive over a duplicate accounting entry. Same-date identical transactions can require explicit inspection.
- Bank rules are suggestions only; they are never silently applied to accounting vouchers.
- Marketplace file headers vary and must be mapped explicitly. Gross vs net/GST-inclusive semantics, GST on platform fees, past-period adjustments, reserves, claims, reversals and withholding must be checked by the accountant. A balancing report alone does not establish the correct account treatment.
- Intercompany reports only compare selected ledgers and months. They do not determine the legal/tax nature of transactions.
- Read-only screens and cached snapshots can be incomplete/stale. Confirm totals against TallyPrime and official GST information.
- On a busy PC, Windows startup integrity verification can take additional time. The safe recovery workflow must be exercised against representative on-disk data before any production rollout.

## Testing and release gate
The CI executes `npm test` plus Windows installer-build/install/app-start smoke tests. Additional pure tests cover bank matching and bills, settlement modes, accounting XML, source links, reciprocal ledgers and database backups.

**Do not merge into main or treat this preview as safe for production until:**
- Windows CI and tests are green for the precise final commit.
- Tally XML report exports and bill allocations have been tested in a real TallyPrime test company, with measured signs/amounts and idempotency.
- Representative Meesho/Flipkart settlement files and co-operative-bank statements reconcile correctly.
- A full local backup + forward upgrade + restore + rollback drill has succeeded.
- Permissions, duplicate prevention, retries, app restart and wrong-company protections pass end-to-end.

No real production Tally company, bank statements or marketplace payout files were accessible to this CI run.
