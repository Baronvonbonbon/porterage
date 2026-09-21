// What leaves this phone, said the same way every time (docs/IMPROVEMENTS.md,
// "Copy for the privacy warnings").
//
// There were eight of these, written months apart in eight views. They said
// true things in different voices — one hedged, one boasted, one buried the
// cost in a subordinate clause — and a person reading three screens in a row
// could not tell whether they were being told about three different designs.
// Gathering them is not a refactor for tidiness: consistent phrasing is how
// someone learns the shape of the thing, and once the shape is learned they
// can predict what the next screen will cost them without reading it.
//
// The rules the sentences follow, in order of stubbornness:
//
//   1. Name who learns it. Not "data is shared" — "the counter sees", "that
//      server sees", "one driver learns". A warning without a subject asks
//      someone to imagine the worst, and they will imagine wrong in both
//      directions.
//   2. Say the cost before the comfort. "This is public, and it repeats" comes
//      before "your exact drop stays here". A reassurance placed first is read
//      as the whole sentence.
//   3. Never say "secure", "private" or "anonymous". They are conclusions, and
//      the conclusion is the reader's to draw from the facts above it.
//   4. Present tense, no conditionals. It does this, not it may do this.
//   5. Short enough to be read on a phone mid-order, which is the only time
//      any of them appear.
//
// They are plain strings and functions, not components: several sit inside a
// sentence that has other things in it, and a component would force the whole
// paragraph in here where it would go stale. The seam is this module — change
// a sentence once and every screen that says it changes.

/**
 * The shape of the whole thing, said once on the role screen — the only
 * screen nobody is in the middle of something on. It promises that the rest
 * of the warnings exist, which is why it must not say "below": there is
 * nothing below it, and a sentence that points at nothing teaches someone to
 * stop reading these.
 */
export const SHAPE =
  "The chain records how much, never what and never where. Everything else " +
  "travels sealed to one key, and wherever something can't be sealed, the " +
  "screen that sends it says so.";

// ---- places ----

/**
 * Drawing a map means asking somebody for pictures of it. Said next to the
 * map, because that is the moment the request is about to happen.
 */
export const MAP_TILES =
  "The map fetches tiles from openstreetmap.org, so that server sees roughly " +
  "where you're looking. Typing the coordinates instead sends nothing.";

/** The saved pin for distance filtering, which is never published. */
export const HERE_STAYS = "It stays on this device.";

/**
 * The coarse drop area. The repeat is the part people miss — a square that
 * never changes is a square that accumulates.
 */
export const coarseArea = (at: string, metres: number) =>
  `Publishes a square about a kilometre across — ${at}, give or take ` +
  `${metres} m — so drivers can see how far the trip is before bidding. It is ` +
  `public, and it is the same square every time you deliver here, so a home ` +
  `that orders often is a home in a known square. Your exact drop still never ` +
  `leaves this phone.`;

/** The exact drop, once a driver has won the order. */
export const DROP_SENT =
  "It has your drop, sealed to it alone — it needs that to find you, and " +
  "nobody else can read it.";
export const DROP_WAITING = "It gets your drop as soon as it says hello.";
export const DROP_SENDING = "Sending it your drop…";

/** Following a location off the phone, when the phone's own map app refused. */
export const MAP_FALLBACK =
  "This phone wouldn't open a map app. Copying sends nothing anywhere; the " +
  "web map tells openstreetmap.org where you're going, and may close " +
  "Porterage to do it.";

// ---- orders ----

/** What the venue learns, and what it doesn't. */
export const BASKET_SEALED =
  "The counter is told what to make, sealed to it alone.";
export const BASKET_UNSEALED =
  "This menu has no counter key, so the venue will only see the amount.";
export const VENUE_SEES =
  "What was ordered reaches only this counter: the chain says how much, " +
  "never what.";

/** A menu is the one document in the design that is meant to be read by all. */
export const MENU_PUBLIC =
  "The menu is a small public document on Bulletin, and the venue points at " +
  "it. Customers read it before they have an account, which is why it isn't " +
  "sealed. Bulletin keeps it about two weeks, so republish now and then.";

/**
 * The photo a driver leaves at the door. The key is named on purpose: it is
 * a separate, random key wrapped to the customer, so handing it to an arbiter
 * later hands over one photo and not an identity.
 */
export const photoSealed = (bytes: number) =>
  `Photo stored, sealed to the customer (${(bytes / 1024).toFixed(0)} kB), ` +
  `and its key is on-chain.`;

// ---- disputes ----

/** Why a device that isn't the arbiter sees a queue of locked boxes. */
export const NOT_ARBITER =
  "This device isn't the arbiter, so it can read the queue but not a case — " +
  "every case is sealed to the arbiter's key — and a ruling it signed would " +
  "be refused.";

/**
 * Cashing out, in two sentences that have to do different jobs.
 *
 * The first is the good news and it is specific about WHY it is good news:
 * "every unspent note" is the anonymity set, and naming it is what stops the
 * sentence being a boast (rule 3). The second is the cost, and it comes
 * attached to the button that spends it rather than to the screen, because a
 * warning read three minutes earlier is a warning nobody read.
 */
export const CASH_OUT_PRIVATE =
  "The account this lands in is new, and what paid it could be any unspent " +
  "note. Nothing says it was your work.";

export const sendOnwardCost = (to: string) =>
  `Anyone watching sees ${to} receive this much, now. What it was earned ` +
  `from stays hidden.`;

/**
 * The timing hint. It is a hint and not a rule because the alternative is
 * holding someone's money behind a timer, and a person who needs paying today
 * will work around a timer in a way that leaks more than sending early does.
 */
export const CASH_OUT_TIMING =
  "Sending the same amount minutes later is easy to match up. Leaving it a " +
  "while, or sending part of it, is harder.";
