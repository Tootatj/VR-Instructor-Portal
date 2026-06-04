// Tenant code registry, per Devlog 2026-06-04 (Phase 6 single-code model).
//
// In the production architecture, OneBonsai's existing client-management
// portal issues a single per-tenant "company code" (e.g. "5555555555" →
// Securitas). The same code is used for:
//   1. VR device registration (typed once on first launch, persisted on
//      device, binds that device to a tenant forever).
//   2. Instructor dashboard login (typed in a browser on
//      onebonsai.instructor.com to scope the dashboard to a tenant's
//      sessions).
//
// v1 of this module is a static JSON lookup (data/tenant-codes.json) — it
// IS the contract spec for the eventual OneBonsai portal integration. When
// the portal exposes an HTTP endpoint, swap the body of `resolveByCode` to
// call it and leave every consumer untouched. Wire format stays identical.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODES_PATH = join(__dirname, '..', 'data', 'tenant-codes.json');

// Codes are case-insensitive alphanumeric, 4-32 chars. Digit-only codes
// (e.g., "5555555555") are recommended because the VR text-entry widget
// defaults to the numeric keyboard, which is much faster on a controller
// than the full alphanumeric one. Validation here covers both shapes so
// the eventual portal integration has room to issue mixed codes.
const CODE_PATTERN = /^[A-Za-z0-9]{4,32}$/;

// Same shape as the pairing.js tenant validator — keeps these two modules
// in lockstep on what a "valid tenantId" looks like everywhere on the
// server (channel names, socket rooms, log lines, cookie payloads).
const TENANT_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

// Loaded once at boot. Keys are LOWERCASED code strings; values are
// { tenantId, displayName }. Underscore-prefixed keys in the JSON are
// comments and are dropped.
const REGISTRY = loadRegistry();

function loadRegistry() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CODES_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `failed to load ${CODES_PATH} — make sure the JSON file exists and is well-formed (${err.message})`
    );
  }

  const out = new Map();
  for (const [code, info] of Object.entries(raw)) {
    if (code.startsWith('_comment')) continue;
    if (!CODE_PATTERN.test(code)) {
      throw new Error(`tenant-codes.json: code "${code}" must match ${CODE_PATTERN} (4-32 alphanumeric chars)`);
    }
    if (!info || typeof info !== 'object') {
      throw new Error(`tenant-codes.json: entry for "${code}" must be an object { tenantId, displayName }`);
    }
    if (!TENANT_PATTERN.test(info.tenantId ?? '')) {
      throw new Error(
        `tenant-codes.json: entry for "${code}" has invalid tenantId "${info.tenantId}" — must match ${TENANT_PATTERN}`
      );
    }
    if (typeof info.displayName !== 'string' || info.displayName.length === 0) {
      throw new Error(`tenant-codes.json: entry for "${code}" must have a non-empty displayName string`);
    }
    out.set(code.toLowerCase(), {
      tenantId: info.tenantId,
      displayName: info.displayName,
    });
  }

  if (out.size === 0) {
    console.warn('[VRIP tenants] WARNING: tenant-codes.json has zero entries — every login will fail');
  } else {
    console.log(`[VRIP tenants] loaded ${out.size} tenant code(s): ${[...out.values()].map(t => t.tenantId).join(', ')}`);
  }
  return out;
}

/**
 * Normalize + validate a code string. Returns the lowercased canonical
 * form if valid, or null otherwise. Trim leading/trailing whitespace so
 * an instructor pasting "  5555555555  " from an email still resolves.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!CODE_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Look up a tenant by code. The single source of truth for both VR
 * registration (POST /api/tenant/resolve) and instructor login
 * (POST /api/instructor/login).
 *
 * @param {string} rawCode — raw user input (any case, may have whitespace)
 * @returns {{ tenantId: string, displayName: string } | null} null if the
 *   code format is invalid OR the code isn't in the registry. Callers
 *   should NOT differentiate the two for the user-facing error message
 *   ("Code not recognized" for both) so probing for valid-format-but-
 *   unknown-code yields no extra information to attackers.
 */
export function resolveByCode(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const hit = REGISTRY.get(code);
  if (!hit) return null;
  // Defensive copy — callers must not mutate the registry.
  return { tenantId: hit.tenantId, displayName: hit.displayName };
}

/**
 * Reverse lookup: get the display name for a known tenantId. Used by the
 * dashboard's "Logged in as <name> (<displayName>)" header. Returns null
 * for unknown tenants; callers should fall back to the tenantId string.
 *
 * @param {string} tenantId
 * @returns {{ tenantId: string, displayName: string } | null}
 */
export function getTenantInfo(tenantId) {
  for (const info of REGISTRY.values()) {
    if (info.tenantId === tenantId) {
      return { tenantId: info.tenantId, displayName: info.displayName };
    }
  }
  return null;
}

/**
 * True if a tenantId is in the registry. Used by pairing.js as a
 * defense-in-depth check on `headset:register` — the headset's claimed
 * tenant must match some real, code-issued tenant.
 *
 * @param {string} tenantId
 * @returns {boolean}
 */
export function isKnownTenant(tenantId) {
  return getTenantInfo(tenantId) !== null;
}
