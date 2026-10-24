import { sha256 } from '@noble/hashes/sha2.js';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export function certificateFingerprint(sdp) {
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map((m) =>
    m[1].replaceAll(':', '').toLowerCase(),
  );
  if (
    !fingerprints.length ||
    fingerprints.some((f) => !/^[a-f0-9]{64}$/.test(f) || f !== fingerprints[0])
  )
    throw Error('Missing or inconsistent SHA-256 WebRTC certificate fingerprint');
  return fingerprints[0];
}

// Compare the complete 256-bit digest (24 BIP39 words), rather than inventing
// a short-SAS key exchange. The signaling service never chooses this phrase.
export function verificationPhrase(room, ownerFingerprint, guestFingerprint) {
  if (
    !/^[a-f0-9]{32}$/.test(room) ||
    !/^[a-f0-9]{64}$/.test(ownerFingerprint) ||
    !/^[a-f0-9]{64}$/.test(guestFingerprint)
  )
    throw Error('Invalid connection identity');
  return entropyToMnemonic(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          'PhoneHaul Internet peer verification v1',
          room,
          ownerFingerprint,
          guestFingerprint,
        ]),
      ),
    ),
    wordlist,
  );
}
