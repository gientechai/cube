import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';

import { downloadAndExtractFile } from '../src/http-utils';

const originalHttpProxy = process.env.HTTP_PROXY;
const originalHttpsProxy = process.env.HTTPS_PROXY;

beforeAll(() => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
});

afterAll(() => {
  if (originalHttpProxy === undefined) {
    delete process.env.HTTP_PROXY;
  } else {
    process.env.HTTP_PROXY = originalHttpProxy;
  }

  if (originalHttpsProxy === undefined) {
    delete process.env.HTTPS_PROXY;
  } else {
    process.env.HTTPS_PROXY = originalHttpsProxy;
  }
});

async function downloadArchive(
  archive: Buffer,
  cwd: string,
  options: { skipExtract?: boolean; dstFileName?: string } = {}
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Length', archive.length);
    response.end(archive);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind to a port');
    }

    await downloadAndExtractFile(`http://127.0.0.1:${address.port}/archive`, {
      cwd,
      showProgress: false,
      ...options,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }));
  }
}

test('downloadAndExtractFile rejects unsupported archive formats', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-extract-'));

  try {
    await expect(downloadArchive(Buffer.from('not an archive'), cwd)).rejects.toThrow(/Unsupported archive format/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('downloadAndExtractFile extracts a gzip tarball saved without an extension', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-extract-'));
  const source = path.join(work, 'source');
  const destination = path.join(work, 'destination');
  const archive = path.join(work, 'valid.tar.gz');
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(source, 'bin', 'cubestored'), 'binary content');

  try {
    await tar.c({ file: archive, cwd: source, gzip: true }, ['bin']);
    await downloadArchive(fs.readFileSync(archive), destination);
    expect(fs.readFileSync(path.join(destination, 'bin', 'cubestored'), 'utf8')).toBe('binary content');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('downloadAndExtractFile keeps files unchanged when extraction is skipped', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-extract-'));
  const driver = Buffer.from('driver-jar-content');

  try {
    await downloadArchive(driver, cwd, { skipExtract: true, dstFileName: 'driver.jar' });
    expect(fs.readFileSync(path.join(cwd, 'driver.jar'))).toEqual(driver);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('downloadAndExtractFile rejects tar entries that leave the destination', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-extract-'));
  const source = path.join(work, 'source');
  const destination = path.join(work, 'destination');
  const archive = path.join(work, 'unsafe.tar.gz');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(work, 'escape.txt'), 'attacker content');

  try {
    await tar.c({ file: archive, cwd: source, gzip: true, preservePaths: true }, ['../escape.txt']);
    fs.writeFileSync(path.join(work, 'escape.txt'), 'original content');
    await expect(downloadArchive(fs.readFileSync(archive), destination)).rejects.toThrow();
    expect(fs.readFileSync(path.join(work, 'escape.txt'), 'utf8')).toBe('original content');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
