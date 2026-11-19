# Daybook design directions

Three directions for the same three screens (home, pay page with the Paid moment, one state screen). Each folder has its own README with tokens, measured contrast and motion. All values marked "sample" are placeholders: `evidence/loops.csv` did not exist when these were rendered. The QR codes encode a real EIP-681 USDC transfer (Base 8453, Arbitrum 42161, Circle USDC addresses from `ref/FACTS.md`) to the pay address from the local test vector in `scripts/src/payAddress.test.ts`, labelled on the page as not for funds.

| | A. Ledger | B. Letterpress | C. Duplicate book |
|---|---|---|---|
| Idea | Accountant's ledger page that writes itself, red rubber stamp | One-ink Swiss stationery, debossed seal | Carbon-copy receipt pad with stub and perforation, dater stamp |
| Type | Libre Caslon Text + DM Mono | Archivo + Red Hat Mono | Barlow Condensed + Courier Prime |
| Colour | Ledger green paper, green rules, stamp red | Oxblood on stock, nothing else | Kraft board, white and yellow sheets, teal form, carbon blue, stamp red |
| Paid moment | Rubber stamp lands on the invoice | Seal pressed into the card | Dater stamp thumps down, receipt tears off |
| State screen | Wrong token (USDT flagged, not counted) | Expired invoice | Part paid, balance due |
| Dark mode | Full tokens, screenshotted | Full tokens | Board only |
| Print | A4 invoice + receipt | A4 with crop marks | A5 sheet + receipt |
| Risk | Closest to the brief's wording; can drift toward period costume if overdone | Quietest; least "ledger", could read as generic premium stationery | Most character; kraft and Courier are loud for a page a client must trust with money |

Strongest: **A. Ledger.** The central graphic is the product itself: one invoice's ledger lines (received, matched, tax, team, treasury, balance zero) are exactly what the contracts do, so the home page explains the loop without a diagram, and the same ruled sheet carries straight through to the pay page, the ledger view and the CSV export. It also prints best and has the most complete dark mode. Worth taking from the others: B's oversized amount on the pay page and its debossed seal for the printed receipt, and C's yellow "carbon copy" status log.
