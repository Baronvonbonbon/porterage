# Improvements

A working list, kept next to `PLAN.md` rather than inside it: the plan is what the product is,
this is how well it does it. Written 2026-09-20, after the delivery, money, dispute and messaging
phases were all in place and before any of it had been used in anger on a phone.

Each item says what it touches and what it costs, and each is meant to be buildable on its own.
Where something can be swapped out later, the seam is named.

---

## 0. The drop never reaches the driver — DONE 2026-09-20 (`order/drop.ts`)

**The bug.** A driver can bid, win, collect from the venue and then has nowhere to go. The order
carries only `Poseidon(lat, lon, salt)`; the coarse area is opt-in and a kilometre wide; the exact
drop is revealed at the door, by which time the driver has to already be at it. The proximity proof
works. The delivery does not.

**The fix.** When a bid is accepted, the customer seals the exact drop to the winning driver and
nobody else. The driver's key is already in hand — it introduces itself on the order topic the
moment it has the job (`order/chat.ts` `introduce`) — so this is one more sealed envelope on the
pair thread that already exists, kind 13.

- The chain still sees only the commitment. The public record does not change at all.
- One party learns the address: the one delivering to it. That is inherent to delivery, and the
  protection that remains is the one that matters — the order is placed by a burner, so the driver
  learns a place, not a person, and a different order uses a different account.
- It should be automatic on assignment, not a button. A driver stuck outside with no address is a
  failed delivery, and "did you remember to send it" is not a design.
- Until it lands, the coarse area is the only hint a driver has, and that is not good enough.

**Done.** 81 bytes sealed, on the pair thread, one statement per order replaced in place with a
12-hour expiry; the driver keeps a copy in the encrypted book, because an address that vanished
halfway through a delivery would be worse than one that never came. Verified live on 2026-09-20
(`web/tools/live-order.ts` step 5b): the driver read it, the venue could not, and a third party
holding both public keys could not even derive the thread it travelled on. Nothing on-chain changed.
Navigation to it is §4.

---

## 1. A visual pass over the whole app — DONE 2026-09-20

The app is deliberately plain: one stylesheet, semantic elements, no framework. That was right for
getting here and is now the thing holding it back. The pass should stay within that constraint —
no UI library — and fix what plainness cost:

- **A type and spacing scale.** Sizes are currently ad hoc. Six steps, one rhythm, applied through
  the existing custom properties in `styles.css` so nothing else has to change.
- **States, not just happy paths.** Every screen needs a loading, empty, error and finished look.
  Several currently render nothing while they wait, which reads as broken on a slow phone.
- **Hierarchy on the order and job screens.** Both are flat runs of `<dl>` and `<p>`. The one thing
  someone needs next should be the largest thing on the screen.
- **Money and distance formatting in one place.** `format.ts` has some of it; `pasWei`, the ad hoc
  `far()` in Jobs and the `KM()` in Here should be one module.
- **Dark mode**, since the host has a theme provider (`getThemeProvider`) and the app ignores it.

**Done**, and it found two bugs that only existed in the dark:

- A message bubble was hardcoded `#fff` and the map's backdrop `#ddd`. Both looked deliberate in
  daylight and wrong at night. Every colour is a token now, and every token has a dark value.
- **A quiet button inside `.actions` was accent text on an accent fill** — invisible. `.actions
  button` set the background and `button.link`, at equal specificity but later in the file, set only
  the colour. The map picker's Cancel was one of these.

Hierarchy is marked by hand (`.primary`), not taken as "the first button in the group": the bids on
an order live in `.actions` and are sorted cheapest first, so filling the first would recommend the
cheapest when the point is that the customer picks whichever it likes.

`format.ts` now holds the one distance formatter; the three screens that had grown their own
disagreed about when to switch to kilometres. The host's theme is followed (`theme.ts`), with
`prefers-color-scheme` as the fallback rather than the authority. `views/State.tsx` gives waiting a
shape, since a screen that renders nothing while it fetches is the commonest way a working app looks
broken.

Checked by rendering the built app in headless Chromium at phone width, light and dark, rather than
by reading the CSS — which is how the missing heading on the label filter was spotted.

**Seam:** all of it lands in `styles.css` custom properties and a handful of small components. No
view logic changes.

## 2. Forms and pickers that behave inside the app — DONE 2026-09-20 (`views/pickers/`)

The `<select>` bug — the list rendered, nothing could be picked, ordering was impossible on a phone
— is unlikely to be the only one. `views/Choose.tsx` fixed that case. What is left:

- **Audit every input.** Numbers, decimals, checkboxes, the camera, the textareas in the QR
  fallback. Each needs to be confirmed on a device, not assumed.
- **Amount entry.** Typing "1.5" into a bare text box is how people fund the wrong thing by a
  factor of ten. Steppers and preset chips for the common amounts.
- **A picker module** (`views/pickers/`) holding Choose, Stars, the amount field and the map pick,
  so the next thing that turns out to be broken in the WebView is fixed in one place.
- **Validation that says what is wrong** next to the field, rather than an error at the bottom
  after the tap.

**Done.** `views/pickers/` now holds Choose, ChooseMany, Stars, MapPick, Amount and Count, exported
from one index; views import controls rather than raw inputs, so the next thing that turns out to be
broken on a device is fixed once.

The amount parse was the real find. Every screen taking an amount ran this inline:

    BigInt(Math.round(Number(text) * 1e6)) * 10n ** 12n

which is three faults in one line. `Number("one")` is NaN and `BigInt(NaN)` throws a message about
NaN half a second after the tap; the rounding silently dropped anything past six decimals, so
1.2345678 became 1.234568 without saying so; and zero or a negative went straight into a
transaction. `money/amount.ts` replaces it, says what is wrong in words that sit next to the field,
and keeps all eighteen decimals the chain can hold. Four screens had their own parser; there is one
now.

Counts are a stepper, which is the one place a stepper beats a field: small numbers, changed one at
a time, beside the thing being counted.

An "all of it" chip was built and removed before publishing — on the bid field it would have read as
"bid the maximum", which is not something a tool should suggest.

**Seam:** one directory, one export per control. Views import controls, never raw inputs.

## 3. Venue labels and filtering — DONE 2026-09-20 (`order/labels.ts`)

A fixed vocabulary in the menu JSON on Bulletin — free to change, no contract work, and it filters
cleanly because everybody uses the same words. Free text was considered and rejected: "coffee",
"Coffee" and "espresso bar" are three filters.

- Starting set: `coffee`, `bakery`, `hot-food`, `groceries`, `pharmacy`, `alcohol`, `hardware`,
  `other`. Enough to be useful, short enough to show as chips.
- The venue picks up to two when publishing its menu (`views/Venue.tsx`), and they ride in the menu
  document (`order/menu.ts`).
- Customers filter by label beside the distance filter already there, using the same `Choose`
  control.
- **The cost, and it is real:** filtering by label means fetching every venue's menu from Bulletin
  before the list can be drawn. Today the app only fetches the chosen venue's. Either accept the
  delay, cache menus in the encrypted book, or move the category on-chain later.

**Done**, with the menu cache built first so the cost above is paid once rather than on every
screen. A Bulletin URI is the hash of its content, so a cached menu can never be stale — a changed
menu is a different URI, and the venue's on-chain pointer changes with it. The cache lives in the
encrypted book, 60 menus, oldest use first out: a menu is public, but WHICH menus a device has
fetched says where its owner shops, and the book is already encrypted.

A label this version doesn't know is dropped when a menu is read, rather than displayed — an unknown
word can't be filtered on, so showing it would mislead. Venues claim up to two; a venue claiming
everything is claiming nothing.

**Seam:** `order/labels.ts` holds the vocabulary. Moving it on-chain later changes that module and
the filter's data source, not the UI.

## 4. Open a location in a map app — BUILT 2026-09-20 (`order/directions.ts`), rung 1 unmeasured

**What is known:** the host exposes `navigateTo(url)`, and sonde measured it passing on the phone
in 28–44 ms. **What is not known:** whether it hands a `geo:` URI to the OS so a real map app
opens, or navigates the WebView. That is one probe away and should be measured before the UI
promises anything.

The ladder, in `order/directions.ts`:

1. `geo:<lat>,<lon>?q=<lat>,<lon>` through `navigateTo` — the OS picks the map app.
2. An `https://` map URL if that fails. **This tells a third party where someone is going**, so it
   is a fallback with a warning, never the first choice.
3. Coordinates with a copy button, which sends nothing anywhere.

Offered for: the venue (public, safe, useful to both customer and driver), the drop **for the
driver once item 0 has sent it**, and the coarse area when that is all there is.

**Built, with one change of order and the reason for it.** Rung 2 is NOT tried automatically. sonde
measured `navigateTo` navigating the WebView — it pointed the call at its own page and watched it
reload — so an https map URL would not open a tab, it would REPLACE the app and throw away an order
someone is in the middle of. So rung 1 is one tap; if the host refuses it, rungs 2 and 3 both appear
with what each costs written beside them, and the person chooses.

Offered on the driver's job (the counter, and the drop once §0 has sent it) and on the customer's
live order (the venue). `views/Directions.tsx` is the whole UI.

**Still to measure on a phone:** whether `navigateTo` hands a `geo:` URI to the OS at all. The code
reports "opened" or "refused" rather than assuming, so the phone will simply show which branch it
took — if the extra links appear, rung 1 was refused.

**Seam:** one module, three functions, and the UI reads the outcome. A measured answer changes
`openInMapApp` and nothing else.

---

## Smaller things worth doing — ALL DONE 2026-09-20

- **Order history.** `allOrders()` is in the book; nothing shows a finished order.
- **A "what is happening" line** on the order screen. Stages exist (`PlaceStage`) but only during
  placement.
- **Retry the things that can half-fail.** `resumeFunding` does this for tips; the basket, the
  area and the intro do not.
- **The venue's own rating and takings** on one screen. Both exist, neither is prominent.
- **Copy for the privacy warnings.** There are now six or seven of them, written at different
  times. They should read as one voice and be one module, not string literals in views.

**Done**, and three of the five turned out to be bigger than "smaller".

`order/progress.ts` is the "what is happening" line, and writing it forced a question the status
enum never answered: *whose* next move is it? `progressOf(order, who)` takes the party, because
"waiting for the driver to collect it" and "collect it from the counter" are the same status seen
from two ends, and a screen that shows a driver the customer's sentence is telling it to wait for
itself. Delivered is `done` for everyone; Disputed is not done for anybody, and says so rather than
reading as finished.

**Retrying the half-failed sends was the one with a real bug under it.** Placing an order did
`createOrder`, then `announceOrder`, then the basket, then the intro — four awaits in a row, and
only the first is on-chain. A statement that failed after the order existed left an order nobody
could bid on and no record that anything was missing, and the customer's screen showed an order
sitting there attracting nothing. `flow.ts` now records what it owes on the order (`owes`), keeps
the basket it needs to resend, and `settleDebts` retries when the order is reopened — which is the
moment someone is looking at it and a stall is most visible. Nothing after `createOrder` can throw
any more: the order exists, so the screen must open.

The venue's takings needed a fact checking before the copy could be written: `PorterOrders`
credits the venue at **pickup**, not delivery, so the sentence on screen says so. The Sell screen
now leads with the rating and the money waiting, carries the contract's own `pickups` count, and
has the `Earnings` block that takes it out — it was previously only on the driver's screen, so a
venue could see what it was owed and not collect it. It also had the last hand-rolled amount parse
in the app, in the menu price field; `pasPlain` and the `Amount` control replaced it, with a
round-trip test, because a price field that silently reformats what someone typed is a field people
fight.

`copy/privacy.ts` holds the eight warnings and the rules they follow, written down at the top:
name who learns it, cost before comfort, never say "secure" or "private" (those are conclusions,
and the conclusion is the reader's), present tense. The point is not tidiness — consistent phrasing
is how someone learns the shape of the thing, and once learned they can predict what the next
screen costs them without reading it. Headless rendering caught the first sentence promising
warnings "below" on a screen with nothing below it, which is how you teach someone to stop reading
these.

**Seam:** `progressOf` is a pure function of (status, party); `settleDebts` is a pure retry over a
record; the copy is strings. All three are swappable without touching a view's logic.

## Needs a phone before it can be built honestly — NOW ONE SCREEN, 2026-09-20 (`probe.ts`)

- Does `navigateTo` open a map app from `geo:`?
- Does a Bulletin write cost a tap each time, or only the first? This decides how freely the
  archive in `order/chat.ts` can be written.
- Do the QR handoffs, the camera, the basket to the counter and the swap work on a device at all?
  None have been run outside a test.
- Does a host notification actually arrive when the app is backgrounded?

These sat here because nothing in a test could answer them, and that is the problem with them:
a comment saying "unmeasured" is honest once, and after that it is a thing everyone routes around.
`views/Probe.tsx` ("Check this phone", under the role chooser) turns all four into runs of a
couple of minutes and writes down what the phone actually did. Nothing in it touches an order, an
account or any money.

Three things make a probe different from an ordinary screen, and they are the whole design:

- **A probe can destroy the page that started it.** `navigateTo` with an `https` URL navigates the
  WebView, and what it does with `geo:` is the very thing being asked. So a probe writes "I am
  about to do X" to `localStorage` **before** it does X, and the screen asks about any unfinished
  probe when it next loads. `"probe"` is a saved role for the same reason: the app has to come back
  to the screen that knows a run was in flight. Surviving the thing being measured is the trick.
- **The interesting part is usually invisible to code.** The app cannot see an approval prompt and
  cannot see a notification land on a lock screen. So each probe pairs what it *can* measure (an
  outcome, a duration) with a plain question for the person holding the phone, and the two are
  recorded separately and never merged. A resolved promise is not a map app opening.
- **The result is meant to leave the phone**, as text to paste into this repo, because a
  measurement nobody wrote down has to be taken again.

The camera probe is a loopback: it builds a real signed pickup code, shows it, and asks the phone
to scan its own screen — the handoff minus the second phone, exercising the encoder and the scanner
together.

Found while building it: the host's `scheduledAt` is a **bigint** of milliseconds, not a number.

**Still needs the phone**, and only the phone: the basket to the counter and the token swap are not
in here, because both spend real money and belong in the Phase 7 run rather than in a probe.

**Seam:** `probe.ts` is the questions and the record; the screen only runs them. Adding a fifth
question is one entry in `QUESTIONS` and one function.
