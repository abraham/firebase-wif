import { describe, expect, it } from 'vitest';
import { ghCliClient, type GhResult } from '../src/gh.js';

const runner = (result: Partial<GhResult>) => {
  const calls: { args: string[]; input?: string }[] = [];
  const run = async (args: string[], input?: string): Promise<GhResult> => {
    calls.push(input === undefined ? { args } : { args, input });
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { run, calls };
};

describe('ghCliClient', () => {
  it('sends requests through gh api', async () => {
    const { run, calls } = runner({ stdout: '{"id":42}' });
    const client = ghCliClient({ run });
    expect(await client.request('GET', '/repos/o/r')).toEqual({ id: 42 });
    expect(calls).toEqual([
      {
        args: [
          'api',
          'repos/o/r',
          '--method',
          'GET',
          '-H',
          'Accept: application/vnd.github+json',
          '-H',
          'X-GitHub-Api-Version: 2022-11-28',
        ],
      },
    ]);
  });

  it('passes bodies on stdin and accepts empty responses', async () => {
    const { run, calls } = runner({ stdout: '' });
    expect(
      await ghCliClient({ run }).request('POST', '/repos/o/r/actions/variables', { name: 'A', value: '1' }),
    ).toEqual({});
    expect(calls[0]!.args.slice(-2)).toEqual(['--input', '-']);
    expect(calls[0]!.input).toBe('{"name":"A","value":"1"}');
  });

  it('turns HTTP failures into status errors', async () => {
    const { run } = runner({ code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' });
    await expect(ghCliClient({ run }).request('GET', '/repos/o/missing')).rejects.toMatchObject({
      name: 'HttpError',
      status: 404,
      message: 'Not Found (HTTP 404)',
    });
  });

  it('reports a signed-out or missing gh as missing credentials', async () => {
    const signedOut = runner({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
    await expect(ghCliClient(signedOut).request('GET', '/repos/o/r')).rejects.toMatchObject({
      code: 'NO_GITHUB_CREDENTIALS',
      fix: 'gh auth login',
    });

    const missing = async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    };
    await expect(ghCliClient({ run: missing }).request('GET', '/repos/o/r')).rejects.toMatchObject({
      code: 'NO_GITHUB_CREDENTIALS',
    });

    const broken = async () => {
      throw new Error('EPIPE');
    };
    await expect(ghCliClient({ run: broken }).request('GET', '/repos/o/r')).rejects.toThrow('EPIPE');
  });

  it('reports other failures without a status', async () => {
    const { run } = runner({ code: 1, stderr: '' });
    const error = await ghCliClient({ run })
      .request('GET', '/repos/o/r')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'gh api exited with 1' });
    expect((error as { status?: number }).status).toBeUndefined();
  });

  it('runs the real gh binary by default', async () => {
    // A path gh rejects locally, so this never reaches the network.
    const error = await ghCliClient()
      .request('GET', '--version')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
  });
});
