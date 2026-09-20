// One conversation, for whichever two parties are holding it (order/chat.ts).
//
// The same component serves all three pairings, because a thread only ever
// needs this device's key and the other party's. It says plainly where the
// messages go and what they cost, since "encrypted" alone doesn't tell anyone
// that a thread is a window, not a history.

import { useEffect, useRef, useState } from "react";
import { MAX_TEXT, say, watchThread, type Message } from "../order/chat";
import type { Reader } from "../order/seal";
import { connectLive, type Live } from "../order/live";
import { tell } from "../notify";
import { errorText } from "../format";

export function Thread({
  mine,
  theirs,
  orderId,
  title,
}: {
  mine: Reader;
  theirs: string;
  orderId: bigint;
  title: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const foot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let gone = false;
    watchThread(mine, theirs, orderId, (m) => !gone && setMessages(m))
      .then((s) => (gone ? s() : (stop = s)))
      .catch((e) => !gone && setError(errorText(e)));
    return () => {
      gone = true;
      stop?.();
    };
  }, [mine, theirs, orderId]);

  // Beside the thread, try for a direct channel. It only connects when both
  // sides are online and can reach each other, so nothing waits on it and its
  // failure is silent — the statements are the transport of record.
  useEffect(() => {
    let channel: Live | null = null;
    let gone = false;
    connectLive(mine, theirs, orderId, (heardText) => {
      // Shown at once; the statement window catches an offline reader up.
      setMessages((all) => [
        ...all,
        { at: Date.now(), text: heardText, mine: false },
      ]);
      tell("message", orderId);
    })
      .then((c) => {
        channel = c;
        if (gone) c?.close();
        else setLive(c);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      channel?.close();
    };
  }, [mine, theirs, orderId]);

  useEffect(() => {
    foot.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Straight down the wire if there is one, so the other side sees it now;
      // the statement goes out regardless, so it survives them being away.
      live?.send(text);
      await say(mine, theirs, orderId, text);
      setText("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="thread">
      <h3>{title}</h3>
      <div className="thread-log">
        {messages.length === 0 && <p className="muted">Nothing said yet.</p>}
        {messages.map((m, i) => (
          <p key={`${m.at}-${i}`} className={m.mine ? "said mine" : "said"}>
            {m.text}
            <span className="muted">
              {" "}
              {new Date(m.at).toLocaleTimeString()}
            </span>
          </p>
        ))}
        <div ref={foot} />
      </div>

      <div className="actions">
        <input
          value={text}
          maxLength={MAX_TEXT}
          placeholder="Say something"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && send()}
        />
        <button disabled={busy || !text.trim()} onClick={send}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">
        Only the two of you can find this thread or read it. It holds the recent
        messages, not the whole conversation, and everything in it disappears
        within the hour.
        {live ? " You're connected directly, so messages arrive at once." : ""}
      </p>
    </div>
  );
}
