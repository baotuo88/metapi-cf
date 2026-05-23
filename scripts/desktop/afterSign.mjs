import { notarize } from '@electron/notarize';
import { ensureAdHocSignature, getMacAppPath } from './macosSignUtils.mjs';

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = getMacAppPath(context);
  const appleId = process.env.APPLE_ID || process.env.APPLEID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLEIDPASS;
  const teamId = process.env.APPLE_TEAM_ID;
  const signature = await ensureAdHocSignature(appPath);

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[metapi-desktop] Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not fully configured.');
    return;
  }

  if (signature.isAdHoc) {
    console.log('[metapi-desktop] Skipping notarization: macOS app is only ad-hoc signed. Configure a Developer ID certificate to enable notarization.');
    return;
  }

  console.log('[metapi-desktop] Notarizing macOS build...');
  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
}
