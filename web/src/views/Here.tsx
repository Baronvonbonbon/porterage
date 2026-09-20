// Where this device says it is, and how far it cares to look.
//
// The app can't read the phone's position — the WebView refuses geolocation —
// so the pin is set by hand, on the map or by typing. It is kept in the
// device's encrypted storage and never published: filtering happens here, on
// the list this device already has, so nobody learns what anyone searched for.
//
// A driver moves during a shift, so "move" is a button and not a settings page.

import { useEffect, useState } from "react";
import { formatDegrees, type Position } from "../order/geo";
import { metres } from "../format";
import { saveHere, savedHere } from "../shield/notes";
import { MapPick } from "./pickers/MapPick";

export interface Here {
  lat: number;
  lon: number;
  metres: number;
}

/** Read the saved pin once, for a screen that only wants to filter by it. */
export function useHere(): [Here | null, (h: Here | null) => void] {
  const [here, setHere] = useState<Here | null>(null);
  useEffect(() => {
    let on = true;
    savedHere().then((h) => on && setHere(h));
    return () => {
      on = false;
    };
  }, []);
  const put = (h: Here | null) => {
    setHere(h);
    saveHere(h).catch(() => undefined);
  };
  return [here, put];
}

const KM = metres;

export function HerePin({
  here,
  onChange,
  start,
  what,
}: {
  here: Here | null;
  onChange: (h: Here | null) => void;
  /** Where the map opens when there's no pin yet. */
  start: Position;
  /** What the radius filters, for the sentence. */
  what: string;
}) {
  const [moving, setMoving] = useState(false);
  const [radius, setRadius] = useState(String((here?.metres ?? 5000) / 1000));

  useEffect(() => {
    if (here) setRadius(String(here.metres / 1000));
  }, [here]);

  if (moving) {
    return (
      <MapPick
        venue={here ? { lat: here.lat, lon: here.lon } : start}
        initial={here ? { lat: here.lat, lon: here.lon } : undefined}
        onCancel={() => setMoving(false)}
        onPick={(p) => {
          onChange({ lat: p.lat, lon: p.lon, metres: here?.metres ?? 5000 });
          setMoving(false);
        }}
      />
    );
  }

  if (!here) {
    return (
      <p className="muted">
        <button className="link" onClick={() => setMoving(true)}>
          Set where you are
        </button>{" "}
        to see only {what} near you. It stays on this device.
      </p>
    );
  }

  return (
    <div className="actions here">
      <p className="muted">
        You're at {formatDegrees(here.lat)}, {formatDegrees(here.lon)} — showing{" "}
        {what} within {KM(here.metres)}.{" "}
        <button className="link" onClick={() => setMoving(true)}>
          move
        </button>{" "}
        <button
          className="link"
          onClick={() => {
            onChange(null);
            setRadius("5");
          }}
        >
          show everything
        </button>
      </p>
      <label>
        Within{" "}
        <input
          inputMode="decimal"
          size={4}
          value={radius}
          onChange={(e) => {
            setRadius(e.target.value);
            const km = Number(e.target.value.trim());
            if (Number.isFinite(km) && km > 0)
              onChange({ ...here, metres: Math.round(km * 1000) });
          }}
        />{" "}
        km
      </label>
    </div>
  );
}
