import { ensureAdHocSignature, getMacAppPath } from './macosSignUtils.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  await ensureAdHocSignature(getMacAppPath(context));
}
