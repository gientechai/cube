/* eslint-disable no-restricted-syntax */
import { downloadAndExtractFile } from '@cubejs-backend/shared';
import process from 'process';
import * as path from 'path';

import { getTarget } from './utils';

export function getCubeStorePath() {
  return path.join(path.resolve(__dirname, '..', '..'), 'downloaded', 'latest');
}

export function getBinaryPath() {
  const binaryName = process.platform === 'win32' ? 'cubestored.exe' : 'cubestored';

  return path.join(getCubeStorePath(), 'bin', binaryName);
}

export async function downloadBinaryFromRelease() {
  // eslint-disable-next-line global-require
  const { version } = require('../../package.json');
  const cubestorePath = getCubeStorePath();
  const currentTarget = getTarget();

  const url = `https://github.com/cube-js/cube.js/releases/download/v${version}/cubestored-${currentTarget}.tar.gz`;

  try {
    await downloadAndExtractFile(url, {
      cwd: cubestorePath,
      showProgress: true,
    });
  } catch (e: any) {
    if (e.toString().includes('Not Found')) {
      throw new Error(
        `Cube Store v${version} Artifact for ${currentTarget} doesn't exist. Most probably it is still building. Please try again later.`
      );
    } else {
      throw e;
    }
  }
}
