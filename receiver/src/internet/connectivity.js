export const DIRECT_UNAVAILABLE =
  'Direct connection unavailable. Your networks may restrict peer-to-peer connections. Try another network or use PhoneHaul on the same LAN.';

export function checkIcePolicy(mode, iceServers = [], sdp = '') {
  if (!['stun-only', 'turn-enabled'].includes(mode)) throw Error('Unknown connectivity policy');
  if (mode !== 'stun-only') return;
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (urls.some((url) => typeof url !== 'string' || !url.startsWith('stun:')))
      throw Error('Configuration violation: only STUN servers are allowed.');
  }
  if (/^a=candidate:.*\btyp relay\b/m.test(sdp))
    throw Error('Configuration violation: relay candidates are forbidden in STUN-only mode.');
}

export function selectedTransport(stats, mode) {
  const entries = [...stats.values()];
  const transport = entries.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = transport
    ? stats.get(transport.selectedCandidatePairId)
    : entries.find((s) => s.type === 'candidate-pair' && s.selected);
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId),
    remote = stats.get(pair.remoteCandidateId);
  if (mode === 'stun-only' && [local, remote].some((c) => c?.candidateType === 'relay'))
    throw Error('Configuration violation: selected relay transport in STUN-only mode.');
  return {
    local: local?.candidateType ?? 'unknown',
    remote: remote?.candidateType ?? 'unknown',
    protocol: local?.protocol ?? 'unknown',
  };
}
