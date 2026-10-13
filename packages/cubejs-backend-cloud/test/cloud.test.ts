import { CubeCloudClient } from '../src/cloud';
import { createServer } from 'http';
import { Readable } from 'stream';
import type { ReadStream } from 'fs';

test('CubeCloudClient: constuctor', async () => {
  const cubeCloudClient = new CubeCloudClient({
    auth: '',
    url: '',
    deploymentId: ''
  });
  expect(cubeCloudClient).not.toBeUndefined();
});

test('uploadFile does not let a file name inject a multipart header', async () => {
  let body = '';
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
      body += chunk.toString();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const client = new CubeCloudClient({
      auth: 'test-token',
      deploymentId: 'test-deployment',
      url: `http://127.0.0.1:${address.port}`,
    });
    await client.uploadFile({
      transaction: 'test-transaction',
      fileName: 'report.csv"\r\nX-Injected: true\r\nfake="',
      data: Readable.from([Buffer.from('a,b\n1,2\n')]) as ReadStream,
    });

    expect(body).not.toMatch(/Content-Disposition:[^\r\n]*\r\nX-Injected: true\r\n/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
