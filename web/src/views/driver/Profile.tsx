// A driver's profile (order/profile.ts).
//
// The split this screen has to make legible: the name and the vehicle are
// PUBLIC and the photo is not. A driver about to hand over a photograph of
// their own face deserves to know which of those it is before they tap, so the
// two halves are separate blocks with separate buttons and the cost written
// next to each.

import { useEffect, useState } from "react";
import {
  keyHex,
  MAX_NAME,
  MAX_VEHICLE,
  profileOf,
  publishProfile,
  sealFace,
  type Profile as Row,
} from "../../order/profile";
import { shrink } from "../../order/shopfront";
import { errorText } from "../../format";

/** The face's content key never leaves this device except sealed per order. */
const FACE_KEY = "porterage.face.v1";

export function Profile({ driver }: { driver: string }) {
  const [name, setName] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [face, setFace] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    profileOf(driver)
      .then((p: Row | null) => {
        if (!on || !p) return;
        setName(p.name);
        setVehicle(p.vehicle ?? "");
        setFace(p.face);
      })
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [driver]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h3>Your profile</h3>
      <p className="muted">
        Customers see this next to your bid, beside your rating. A name and a
        vehicle are what someone picks between three bids on — an address isn't.
      </p>

      <div className="actions">
        <label>
          Called{" "}
          <input
            value={name}
            maxLength={MAX_NAME}
            placeholder="Sam"
            onChange={(e) => setName(e.target.value)}
            size={14}
          />
        </label>
        <label>
          Driving{" "}
          <input
            value={vehicle}
            maxLength={MAX_VEHICLE}
            placeholder="blue Honda scooter"
            onChange={(e) => setVehicle(e.target.value)}
            size={20}
          />
        </label>
      </div>
      <p className="warn">
        These two are public: anyone reading the store can read them, and they
        stay readable for as long as they're there. Use a name you're happy to
        be known by at a door, not one off a document.
      </p>

      <h3>Your photo</h3>
      <p className="muted">
        This one is <b>not</b> public. It's encrypted before it leaves the
        phone, and the key goes only to the customer whose order you win, once
        you've won it. So the person at the door knows who to expect, and nobody
        browsing bids can collect your face.
      </p>
      <label>
        Photo{" "}
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            await run("Storing your photo", async () => {
              const { bulletin, contentKey } = await sealFace(
                await shrink(file)
              );
              // The key stays here. Without it the bytes on Bulletin are
              // noise, including to whoever runs Bulletin.
              try {
                localStorage.setItem(FACE_KEY, keyHex(contentKey));
              } catch {
                /* a device that can't remember it will ask again */
              }
              setFace(bulletin);
              setSaved(false);
            });
          }}
        />
      </label>
      {face && (
        <p className="ok">
          Photo stored, encrypted. It goes live when you publish the profile.
        </p>
      )}

      <div className="actions">
        <button
          className="primary"
          disabled={!!busy || !name.trim()}
          onClick={() =>
            run("Publishing your profile", async () => {
              await publishProfile({
                name,
                vehicle: vehicle.trim() || undefined,
                face,
              });
              setSaved(true);
            })
          }
        >
          Publish the profile
        </button>
      </div>
      {saved && (
        <p className="ok">Published. Bids will carry it from now on.</p>
      )}
      {busy && <p className="muted">{busy}… approve it in the Polkadot app.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** The content key for this device's face, if one was stored. */
export function myFaceKey(): string | null {
  try {
    return localStorage.getItem(FACE_KEY);
  } catch {
    return null;
  }
}
