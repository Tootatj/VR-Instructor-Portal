// Agora token minting + channel naming, per .cursorrules §4.3.1.
//
// Every token issuance writes a usage row to stdout (tenantId, seatId,
// channel, role, issuedAt, expiresAt) for later billing/subscription
// reconciliation, even though v1 has no active subscription gating yet.

// agora-token ships as CommonJS, so we can't destructure on the import line
// in an ESM context (Node refuses unknown named exports from a CJS module).
// The default-import + destructure is the official ESM-from-CJS workaround.
import pkg from 'agora-token';
const { RtcTokenBuilder, RtcRole } = pkg;

const TTL_SECONDS = Number(process.env.AGORA_TOKEN_TTL_SECONDS ?? 1800);

/**
 * Single seam where we resolve "which Agora project does this tenant live in?".
 * v1: every tenant resolves to the same env-var pair (Option A topology in
 * §4.3.1). To migrate to per-tenant Agora projects later, swap the body of
 * this function to read from a tenant→credentials map — every call site
 * already passes a tenantId, so no other code needs to change.
 *
 * @param {string} _tenantId — currently unused; threaded for future-proofing.
 * @returns {{ appId: string, appCertificate: string }}
 */
export function getAgoraCredentials(_tenantId) {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  if (!appId || !appCertificate) {
    throw new Error(
      'AGORA_APP_ID and AGORA_APP_CERTIFICATE must be set in .env (see .env.example)'
    );
  }
  return { appId, appCertificate };
}

/**
 * Mint a short-lived RTC token bound to a specific channel + uid.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.channel — must already follow the t-<tenantId>-<code> convention
 * @param {number} args.uid — 0 lets the SDK assign at join time
 * @param {'publisher'|'subscriber'} args.role
 * @returns {{ appId: string, token: string, channel: string, uid: number, expiresAt: number }}
 *   expiresAt is unix-seconds (NOT ms — matches Agora's expiry field unit).
 */
export function mintToken({ tenantId, channel, uid, role }) {
  const { appId, appCertificate } = getAgoraCredentials(tenantId);
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const agoraRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channel,
    uid,
    agoraRole,
    expiresAt,
    expiresAt
  );

  logUsage({ tenantId, channel, role, uid, expiresAt });

  return { appId, token, channel, uid, expiresAt };
}

/**
 * Per .cursorrules §4.3.1: every issuance gets a row. v1 writes to stdout
 * so it's tail-able from any operator console; Phase 4+ promotes this to a
 * real DB write when billing kicks in.
 */
function logUsage({ tenantId, channel, role, uid, expiresAt }) {
  const issuedAt = new Date().toISOString();
  const expiresIso = new Date(expiresAt * 1000).toISOString();
  console.log(
    `[VRIP usage] ${issuedAt} tenant=${tenantId} channel=${channel} ` +
    `role=${role} uid=${uid} expiresAt=${expiresIso}`
  );
}

/**
 * Build the canonical channel name (per .cursorrules §4.3.1). Centralised
 * here so neither the client nor the BP side ever hand-builds the string.
 *
 * @param {string} tenantId
 * @param {string} pairingCode — 4-digit string
 * @returns {string} `t-<tenantId>-<pairingCode>`
 */
export function channelNameFor(tenantId, pairingCode) {
  if (!/^[a-zA-Z0-9_-]+$/.test(tenantId ?? '')) {
    throw new Error(`invalid tenantId: ${tenantId}`);
  }
  if (!/^\d{4}$/.test(pairingCode ?? '')) {
    throw new Error(`invalid pairingCode (must be 4 digits): ${pairingCode}`);
  }
  return `t-${tenantId}-${pairingCode}`;
}
