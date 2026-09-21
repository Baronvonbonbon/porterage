// The page half of the loopback check (tools/rtc-loopback.mjs).
//
// Two peer connections in one page, signalled only through what a statement
// could carry: the offer is cut to a signal, encoded, decoded and rebuilt from
// the template before the other side is allowed to see it. If the template is
// wrong, setRemoteDescription throws and nothing opens — which is the whole
// reason this exists, since the rebuild can't be checked by reading it.

import {
  decodeSignal,
  encodeSignal,
  readSdp,
  writeSdp,
} from "../src/order/live";

const report = (m: string) =>
  fetch("http://127.0.0.1:8731/result", {
    method: "POST",
    mode: "no-cors",
    body: m,
  }).catch(() => {});

const gathered = (pc: RTCPeerConnection) =>
  new Promise<void>((r) => {
    if (pc.iceGatheringState === "complete") return r();
    pc.addEventListener(
      "icegatheringstatechange",
      () => pc.iceGatheringState === "complete" && r()
    );
    setTimeout(r, 4000);
  });

/** Everything a signal goes through between the two sides. */
const roundTrip = (sdp: string) => {
  const signal = readSdp(sdp);
  if (!signal) throw new Error("no signal in that SDP");
  const bytes = encodeSignal(signal);
  const back = decodeSignal(bytes);
  if (!back) throw new Error("the signal didn't survive the round trip");
  return { signal: back, bytes: bytes.length };
};

async function main() {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  const channel = a.createDataChannel("porterage", { ordered: true });
  // The voice line is negotiated on every connection, silent until somebody
  // calls. The point of checking it here is that the audio m-line is rebuilt
  // from a template too, and a template that is wrong fails at
  // setRemoteDescription with nothing readable to debug.
  a.addTransceiver("audio", { direction: "sendrecv" });
  const gotAudio = new Promise<string>((r) => {
    b.ontrack = (e) => r(e.track.kind);
  });
  const heard = new Promise<string>((r) => {
    b.ondatachannel = (e) => (e.channel.onmessage = (m) => r(String(m.data)));
  });

  await a.setLocalDescription(await a.createOffer());
  await gathered(a);
  const offer = roundTrip(a.localDescription!.sdp);
  await b.setRemoteDescription({
    type: "offer",
    sdp: writeSdp(offer.signal, "offer"),
  });

  await b.setLocalDescription(await b.createAnswer());
  await gathered(b);
  const answer = roundTrip(b.localDescription!.sdp);
  await a.setRemoteDescription({
    type: "answer",
    sdp: writeSdp(answer.signal, "answer"),
  });

  await new Promise<void>((r, x) => {
    channel.onopen = () => r();
    setTimeout(() => x(new Error("the channel never opened")), 15_000);
  });
  channel.send("hello from the rebuilt offer");
  const back = await Promise.race([
    heard,
    new Promise<string>((_, x) =>
      setTimeout(() => x(new Error("nothing came back")), 5000)
    ),
  ]);
  // The far side has to have been given a working audio line by the rebuilt
  // SDP, or a call would fail later with the connection apparently fine.
  const kind = await Promise.race([
    gotAudio,
    new Promise<string>((_, x) =>
      setTimeout(() => x(new Error("no audio track was negotiated")), 5000)
    ),
  ]);
  if (kind !== "audio")
    throw new Error(`negotiated a ${kind} track, not audio`);

  // And the voice line must be usable without a second offer: replaceTrack on
  // the already-negotiated sender is what makes a call start at once.
  const sender = a
    .getTransceivers()
    .find((t) => t.sender.track === null)?.sender;
  if (!sender) throw new Error("no sender to put a microphone on");

  // 63 bytes is the sealed envelope's header and tag; 512 is a statement.
  report(
    `OK offer ${a.localDescription!.sdp.length} B of SDP → ${
      offer.bytes
    } B of signal → ${
      offer.bytes + 63
    } B sealed (a statement holds 512); answer ${
      answer.bytes
    } B; heard "${back}"; audio line negotiated`
  );
}

main().catch((e) => report(`FAIL ${e?.message ?? e}`));
