import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';
import * as tar from 'tar';
import fetch from 'node-fetch';

import { PackageFetcher } from '../src/PackageFetcher';

jest.mock('node-fetch', () => jest.fn());

const mockedFetch = fetch as unknown as jest.Mock;

function hardlinkArchive(target: string): Buffer {
  const header = Buffer.alloc(512);
  const octal = (value: number, offset: number, width: number) => {
    header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
  };

  header.write('linked.txt', 0, 'ascii');
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(0, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write('1', 156, 'ascii');
  header.write(target, 157, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  octal(header.reduce((sum, byte) => sum + byte, 0), 148, 8);

  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

test('downloadPackages does not hardlink files outside its temporary directory', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-templates-'));
  const previousCwd = process.cwd();
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const privateFile = path.join(work, 'private.txt');
  fs.writeFileSync(privateFile, 'private content');

  try {
    mockedFetch.mockResolvedValue({ body: Readable.from([hardlinkArchive(privateFile)]) });

    process.chdir(work);
    const packageFetcher = new PackageFetcher({ owner: 'cube-js', name: 'cubejs-playground-templates' });

    await expect(packageFetcher.downloadPackages()).rejects.toThrow();
    expect(fs.existsSync(path.join(work, 'node_modules', '.tmp', 'linked.txt'))).toBe(false);
  } finally {
    process.chdir(previousCwd);
    warning.mockRestore();
    mockedFetch.mockReset();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('downloadPackages extracts a template tarball for installation', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cube-templates-'));
  const previousCwd = process.cwd();
  const repository = path.join(work, 'source', 'cubejs-playground-templates-master');
  const archive = path.join(work, 'templates.tar.gz');
  fs.mkdirSync(path.join(repository, 'packages', 'sample'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'package.json'), '{"name":"template-fixture","version":"1.0.0"}');
  fs.writeFileSync(path.join(repository, 'packages', 'sample', 'index.txt'), 'template content');

  try {
    await tar.c({ file: archive, cwd: path.join(work, 'source'), gzip: true }, ['cubejs-playground-templates-master']);
    mockedFetch.mockResolvedValue({ body: Readable.from([fs.readFileSync(archive)]) });

    process.chdir(work);
    const packageFetcher = new PackageFetcher({ owner: 'cube-js', name: 'cubejs-playground-templates' });
    const { packagesPath } = await packageFetcher.downloadPackages();

    expect(fs.readFileSync(path.join(packagesPath, 'sample', 'index.txt'), 'utf8')).toBe('template content');
  } finally {
    process.chdir(previousCwd);
    mockedFetch.mockReset();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
