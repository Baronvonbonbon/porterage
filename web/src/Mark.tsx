// The Porterage mark.
//
// Porterage is the carrying itself — the word predates the parcel — so the mark
// is a load balanced on a carrier, abstracted down to a box and two strokes.
// Nothing about a van, a scooter or a shopping bag, all of which are somebody
// else's logo already.
//
// Drawn on a 32-unit grid in strokes of `currentColor`, so it inherits the
// text colour, works on either theme without a second asset, and stays legible
// at 16px where a filled illustration turns to mud.
//
// The proportions took four tries and the first three were worse. A load half
// the width of the frame sitting straight on the fork of the legs read as a
// sawhorse — or, once seen, as a figure with an enormous square head. What
// fixes it is a torso: a short stroke between the load and the hips is the
// whole difference between a thing standing there and a thing being carried.
// The load is then offset to one side and tilted well past level, because a
// head is neither, and that is what stops the eye reading one.
//
// The same geometry is inlined by hand in `index.html` for the splash, which
// has to paint before any of this JavaScript exists. If one changes, change
// both — `splash.test.ts` fails when they drift apart.

export function Mark({
  size = 32,
  label,
}: {
  size?: number;
  /** Given only when the mark stands alone; beside the name it is decoration. */
  label?: string;
}) {
  return (
    <svg
      className="mark"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g transform="rotate(-14 15 7)">
        <rect x="8.4" y="3" width="13.2" height="7.6" rx="2" />
      </g>
      <path d="M15.2 12.6 14.4 19" />
      <path d="M14.4 19 9 28.6" />
      <path d="M14.4 19 20.8 28.6" />
    </svg>
  );
}
