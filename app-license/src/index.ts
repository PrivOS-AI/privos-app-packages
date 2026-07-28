import crypto from 'node:crypto';

export interface AppLicenseClaims {
  scope: 'app-license';
  iss: 'privos-marketplace';
  aud: string;
  installationId: string;
  workspaceId: string;
  listingId: string;
  tier: string;
  features: string[];
  serial: string;
  iat: number;
  exp: number;
}

export interface VerifiedAppLicense {
  claims: AppLicenseClaims;
  hasFeature(feature: string): boolean;
  requireFeature(feature: string): void;
}

function decodePart(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export function verifyAppLicense(token: string, publicKeyPem: string, options: { audience: string; now?: number; graceSeconds?: number }): VerifiedAppLicense {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid app license token');
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodePart(encodedHeader) as { alg?: string; typ?: string };
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new Error('unsupported app license algorithm');
  const valid = crypto.verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKeyPem, Buffer.from(signature, 'base64url'));
  if (!valid) throw new Error('invalid app license signature');
  const claims = decodePart(encodedPayload) as AppLicenseClaims;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.scope !== 'app-license' || claims.iss !== 'privos-marketplace') throw new Error('invalid app license scope');
  if (claims.aud !== options.audience) throw new Error('invalid app license audience');
  if (!Array.isArray(claims.features) || !claims.serial || !claims.installationId) throw new Error('invalid app license claims');
  if (now > claims.exp + (options.graceSeconds ?? 0)) throw new Error('app license expired');
  return {
    claims,
    hasFeature: (feature) => claims.features.includes(feature),
    requireFeature(feature) {
      if (!claims.features.includes(feature)) throw new Error(`app license does not grant feature: ${feature}`);
    },
  };
}
