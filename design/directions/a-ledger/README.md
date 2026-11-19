# A. Ledger

**Concept.** Daybook is a bound accountant's ledger: green-ruled sheets, a double red margin rule, every money movement written as a line with a time, a chain and an amount, outflows in brackets. The home page's central graphic is one invoice's ledger page writing itself line by line (received, matched, tax, team, treasury, receipt, balance zero) before a red rubber stamp lands on it. The pay page is the invoice on that same paper, with the payment panel and live status beside it, and the stamp lands on the invoice when the loop closes.

**Type** (two families, both SIL OFL, self-hosted from `@fontsource` in `fonts/`)
- Libre Caslon Text 400, 400 italic, 700 for words. Italic carries the column heads and field labels, as a bookkeeper would write them.
- DM Mono 400/500 for every figure, hash, time and address. Monospaced, so columns align without `tnum`.

**Palette** (`style.css`, light and dark both defined; dark follows `prefers-color-scheme` or `data-theme="dark"`)

| Token | Light | Dark |
|---|---|---|
| `--paper` | `#edf0e0` | `#151d17` |
| `--sheet` | `#f5f6ec` | `#1a231c` |
| `--rule` (non-text) | `#b7cbb0` | `#2b3d2f` |
| `--rule-strong` (non-text) | `#6f9873` | `#4f7556` |
| `--ink` | `#1b2820` | `#e6ead9` |
| `--ink-2` | `#4b5b4f` | `#aab6a3` |
| `--ink-3` | `#66745f` | `#8e9b88` |
| `--red` (stamp, margin rule, flags) | `#a3271f` | `#e8786b` |

Measured WCAG contrast (text pairs): ink on paper 13.23, ink on sheet 14.06, ink-2 on paper 6.24, ink-2 on sheet 6.63, ink-3 on sheet 4.56, red on sheet 6.72, button text (paper on ink) 13.23. Dark: ink on paper 14.05, ink-2 on sheet 7.63, ink-3 on sheet 5.53, red on sheet 5.63. All pass AA for body text.

**Motion.** One sequence on the home page: each ledger line is revealed left to right with a clip-path (520 ms, staggered 420 ms), like a pen crossing the column, then the stamp drops from 1.9x scale with a slight overshoot (320 ms). On the pay page the status lines tick through as the loop advances and the stamp lands on the invoice at Paid. The "now" status mark blinks. Under `prefers-reduced-motion` everything renders in its final state.

**Print.** `@media print` sets A4, drops the chrome, the chain picker and status, keeps the invoice, the stamp, the QR at 32 mm and the receipt, and prints full transaction hashes after each link.

**Borrows from.** Bound double-entry ledgers and day books (the name), red-ruled margins, accountants' bracketed negatives, office rubber stamps with a date line. No brand referenced.

**Screens.** `index.html` (home), `pay.html` (pay page; `?state=paid` shows the closed loop, plain shows waiting, "Replay" walks the sequence), `state.html` (wrong token received: USDT flagged, not counted). Screenshots: `home-*.png`, `pay-*.png`, `state-*.png` at 360, 768 and 1440, plus `pay-waiting-1440.png` and `pay-dark-1440.png`.
