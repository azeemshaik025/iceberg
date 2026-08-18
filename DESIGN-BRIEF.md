# Iceberg — design brief

Paste this into Claude Design. Everything below is real: the numbers are from a live devnet run,
the contract behaviour is implemented and tested.

## What the product is

Iceberg is **private scheduled trading on Starknet**. You buy (or sell) a position gradually —
"put 5,000 USDC into ETH over 10 intervals" — and the blockchain never learns who you are, how
much you're buying in total, or what your schedule is.

It works by batching: every interval, one keeper bot sums that interval's due chunk from *every*
active plan and executes them as a **single anonymous swap**. On-chain, an observer sees only
"the privacy pool swapped 400 USDC for 800 ETH." They cannot tell that was three different people,
who they were, or when they'll buy again.

The name: an iceberg order in traditional finance is a large order where only a small tip is
visible and the bulk stays hidden.

## Who is looking at this

Hackathon judges (STRK20 Private Sprint, deadline Aug 31). They arrive **completely cold**, have
never heard of Iceberg, and will spend perhaps 60 seconds before scoring. Judging weights:
30% protocol integration depth, 30% working product, 25% innovation, 15% documentation.

So the page must do two jobs at once: **teach the idea in ten seconds**, and **prove it works**.

## The core design principle

For almost every privacy product, privacy is invisible — you take it on faith. Iceberg is unusual:
**you can show it**. The screen puts the public record and the private truth side by side, and the
gap between them *is* the product.

So the design's job is evidence, not decoration. Every decision should make that contrast more
visceral. The failure mode of the current UI is that both halves look identical — two views that
should feel like different worlds are rendered as twins.

## The organising metaphor: the waterline

Split the screen horizontally with a literal water surface.

**Above the waterline — what the chain sees.** Bright, exposed, daylight — and deliberately
*starved*. Aggregate swaps only. Where identity would be, show redaction: `—`, `UNKNOWN`, blacked
bars. Monospace. Desaturated. This panel should feel like a public record that refuses to answer.

**Below the waterline — what only you see.** Deep, dark, rich. Your plan decoded: chunk size,
schedule, progress, accrued output. Full colour, real numbers, warm.

A judge should understand the product from a screenshot with the text unread.

## Tone

**Calm, exact, slightly clandestine.** Precision as luxury. Something that handles real money and
doesn't need to shout. Restraint reads as confidence.

Three things to actively avoid:
- Purple/blue gradients with glassmorphism — the stock "web3 dApp" look, instantly forgettable
- Neon cyberpunk — conflates privacy with hacking, and undermines our compliance-friendly story
- Rounded, friendly fintech — wrong audience; this is for people moving size

## Visual language

Inspiration: the "Vertical" design skill from typeui.sh — *polished, high-contrast technical:
cool light-gray surfaces, raised white panels, charcoal accents, strict corners, monospace labels,
editorial serif headings.*

- **Two type registers.** Editorial serif for headings and the thesis line. Monospace, small, and
  uppercase for data labels. Every number uses **tabular figures** so columns align.
- **Strict corners**, hairline borders, no shadows, no gradients (except the waterline itself).
- **Metric row pattern**: small uppercase mono label above a large tabular number.

## What's on the page

One screen. Not a marketing site, not a bare dashboard.

1. **Header band, ~120px.** Product name, one-sentence thesis, and the public/private contrast
   established immediately. NOT a full-height hero — judges must not have to scroll to see proof.
2. **Status strip.** Three metrics: current interval, next interval to execute, active batch size
   per interval.
3. **Above the waterline — the public feed.** A list of executed batches. Real example rows:

   | interval | swapped | received | tx |
   |---|---|---|---|
   | #3 | 400.0000 | 800.0000 | 0x59cb5d97… |
   | #4 | 150.0000 | 300.0000 | 0x396cb278… |
   | #5 | 100.0000 | 200.0000 | 0x2884ba67… |

   The story those rows tell: three plans were mixed in #3, then one schedule ended, then another.
   Nothing identifies anyone. Consider a timeline axis — this runs on a schedule, and static rows
   lose that rhythm.

4. **Below the waterline — your decoded plan.** Enter a secret (never leaves the browser; on-chain
   it's only a Poseidon commitment) and your slice appears:

   - chunk: 100.0000 · window: intervals 1–5 · progress: 5/5 chunks
   - accrued: 1000.0000 · claimed: 0.0000

5. **Actions**: create plan (chunk size + number of chunks), claim accrued, cancel & refund.
6. **Settings** (RPC URL, contract address, token decimals) belong in a drawer — currently they
   occupy the top of the page, which is the worst possible use of that space.

## The two moments worth designing hardest

**1. The mixing moment.** When a batch executes, three separate chunks become one aggregate swap.
That single animation explains the entire product without words — it's the centrepiece of our demo
video. Show the individual amounts converging into one figure, then the identities dropping away.

**2. The decryption moment.** Before a secret is entered, the private panel should show scrambled
or redacted values. Entering the correct secret resolves them into real numbers — a character
scramble settling into plaintext. This is the product thesis expressed as an interaction.

## Honest constraints — do not overclaim

Our privacy model, stated exactly:

- **Hidden**: who created any plan, per-user totals, schedules, claim identity.
- **Public**: individual chunk amounts (but unlinked to anyone), each batch's aggregate swap and
  timing, net flow.

Deposits into the pool are public and compliance-screened by design. We never claim amount privacy
for swaps — the claim is identity privacy plus mixing. The UI must not imply more than that;
overclaiming is the fastest way to lose credibility with these judges.

## Technical constraints

- React (Vite), currently plain CSS, deployed as a **static site** on GitHub Pages
- No backend — the page reads directly from a Starknet RPC and polls every 10 seconds
- Must be responsive; the waterline should stack cleanly on mobile
- Prefer Tailwind-flavoured output — we can adopt it, and it makes porting far cheaper
- Keep heavy WebGL effects optional; the page should be legible and fast without them

## Deliverable

A single-screen application design in this language: layout, type scale, colour tokens, component
shells (metric row, batch row, plan detail, action bar), and the two key moments above.
