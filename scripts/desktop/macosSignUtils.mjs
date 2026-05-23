import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function getMacAppPath(context) {
  return `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
}

export async function inspectSignature(appPath) {
  try {
    const { stdout, stderr } = await execFileAsync('codesign', ['-dv', '--verbose=4', appPath]);
    const output = `${stdout}\n${stderr}`;
    return {
      signed: true,
      isAdHoc: /Signature=adhoc/i.test(output) || !/Authority=/i.test(output),
      details: output,
    };
  } catch {
    return {
      signed: false,
      isAdHoc: false,
      details: '',
    };
  }
}

export async function adHocSign(appPath) {
  await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
}

export async function ensureAdHocSignature(appPath) {
  const signature = await inspectSignature(appPath);
  if (signature.signed) {
    return signature;
  }

  console.log('[metapi-desktop] No macOS signing identity detected, applying ad-hoc signature.');
  await adHocSign(appPath);
  return inspectSignature(appPath);
}
