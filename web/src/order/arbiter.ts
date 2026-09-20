// The arbiter, and how a phone can seal something to it (docs/PLAN.md §6).
//
// The contract knows the arbiter as an ADDRESS, which is a hash: you can check
// a signature against it, but you can't encrypt to it, because ECDH needs the
// point the hash was taken of. So the deploy publishes the arbiter's public key
// in the app's address book — and this module refuses to use it unless it
// hashes to the address the contract actually names.
//
// That check is what makes the shipped key harmless if it's wrong: a dispute
// sealed to the wrong key would be one nobody could read, so it's better to
// fail here, loudly, than to file it.

import { computeAddress } from "ethers";
import { DEPLOYED } from "../config";
import { read } from "../contracts";

const book = DEPLOYED as { arbiter?: string; arbiterKey?: string };

let checked: Promise<string | null> | null = null;

/**
 * The key to seal a dispute to, or null when there's nobody to seal it to —
 * either no arbiter is set or the app wasn't given its key. Both are honest
 * answers, and the UI says which.
 */
export function arbiterKey(): Promise<string | null> {
  return (checked ??= (async () => {
    const onChain: string = await read("disputes").arbiter();
    if (!onChain || onChain === `0x${"0".repeat(40)}`) return null;
    const key = book.arbiterKey;
    if (!key) return null;
    if (computeAddress(key).toLowerCase() !== onChain.toLowerCase()) {
      throw new Error(
        "the arbiter key this app was built with is not the arbiter the contract names"
      );
    }
    return key;
  })().catch((e) => {
    checked = null; // a read that failed shouldn't be remembered as "no arbiter"
    throw e;
  }));
}

/** The address rulings must come from. */
export const arbiterAddress = (): Promise<string> => read("disputes").arbiter();

export function _resetArbiterForTests(): void {
  checked = null;
}
