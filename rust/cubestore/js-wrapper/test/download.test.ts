// eslint-disable-next-line import/no-extraneous-dependencies
import fetch, { Response } from 'node-fetch';

import { downloadBinaryFromRelease } from '../src/download';

jest.mock('node-fetch', () => ({
  ...jest.requireActual('node-fetch'),
  __esModule: true,
  default: jest.fn(),
}));

describe('downloadBinaryFromRelease', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('reports a missing Cube Store release artifact', async () => {
    jest.mocked(fetch).mockResolvedValue(new Response('Not Found', {
      status: 404,
      statusText: 'Not Found',
    }));

    await expect(downloadBinaryFromRelease()).rejects.toThrow(
      /Cube Store .* Artifact for .* doesn't exist/
    );
  });
});
