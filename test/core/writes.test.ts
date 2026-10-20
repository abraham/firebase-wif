import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/core/errors.js';
import type { ProgressEvent } from '../../src/core/types.js';
import {
  defaultSleep,
  MAX_RETRIES,
  POLL_ATTEMPTS,
  retry,
  updatePolicy,
  waitForOperation,
  type Writer,
} from '../../src/core/writes.js';
import type { Policy } from '../../src/core/policy.js';

const writer = (overrides: Partial<Writer> = {}) => {
  const events: ProgressEvent[] = [];
  const sleeps: number[] = [];
  const w: Writer = {
    sleep: async (ms) => void sleeps.push(ms),
    emit: (event) => events.push(event),
    createdServiceAccount: false,
    ...overrides,
  };
  return { w, events, sleeps };
};

describe('defaultSleep', () => {
  it('waits on a timer', async () => {
    const started = Date.now();
    await defaultSleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });
});

describe('waitForOperation', () => {
  it('returns at once for finished operations', async () => {
    const { w, events } = writer();
    const google = { request: async () => ({}) as never };
    await waitForOperation(w, google, 'https://x.test/v1', { name: 'operations/1', done: true }, 'do it');
    expect(events).toEqual([]);
  });

  it('polls by name relative to the API root', async () => {
    const { w, events, sleeps } = writer();
    const urls: string[] = [];
    const google = {
      request: async <T>(_method: string, url: string) => {
        urls.push(url);
        return { name: 'operations/1', done: urls.length === 2 } as T;
      },
    };
    await waitForOperation(w, google, 'https://x.test/v1', { name: 'operations/1' }, 'do it');
    expect(urls).toEqual(['https://x.test/v1/operations/1', 'https://x.test/v1/operations/1']);
    expect(sleeps).toEqual([2000, 2000]);
    expect(events.map((e) => e.type === 'operation:wait' && e.attempt)).toEqual([1, 2]);
  });

  it('throws operation errors and times out', async () => {
    const { w } = writer();
    const failing = {
      request: async <T>() => ({ name: 'operations/1', done: true, error: { code: 9, message: 'nope' } }) as T,
    };
    await expect(waitForOperation(w, failing, 'https://x.test', { name: 'operations/1' }, 'do it')).rejects.toThrow(
      'nope',
    );

    let polls = 0;
    const pending = { request: async <T>() => (polls++, { name: 'operations/1', done: false }) as T };
    await expect(
      waitForOperation(w, pending, 'https://x.test', { name: 'operations/1' }, 'do it'),
    ).rejects.toMatchObject({
      code: 'OPERATION_TIMEOUT',
      message: 'Timed out waiting to do it.',
    });
    expect(polls).toBe(POLL_ATTEMPTS);
    await expect(waitForOperation(w, pending, 'https://x.test', {}, 'do it')).rejects.toMatchObject({
      name: 'WriteError',
      code: 'OPERATION_TIMEOUT',
    });
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const { w } = writer({ signal: controller.signal, sleep: async () => controller.abort() });
    const google = { request: async <T>() => ({}) as T };
    await expect(
      waitForOperation(w, google, 'https://x.test', { name: 'operations/1' }, 'do it'),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('retry', () => {
  it('retries while a delay is returned, up to the limit', async () => {
    const { w, events, sleeps } = writer();
    let attempts = 0;
    await expect(
      retry(
        w,
        'flaky',
        async () => {
          attempts++;
          throw new Error('again');
        },
        () => 10,
      ),
    ).rejects.toThrow('again');
    expect(attempts).toBe(MAX_RETRIES + 1);
    expect(sleeps).toEqual(Array(MAX_RETRIES).fill(10));
    expect(events[0]).toEqual({ type: 'retry', reason: 'flaky', attempt: 1, delayMs: 10 });
  });

  it('returns the first success and never retries aborts', async () => {
    const { w } = writer();
    let attempts = 0;
    expect(
      await retry(
        w,
        'x',
        async () => (++attempts < 3 ? Promise.reject(new Error('x')) : 'ok'),
        () => 0,
      ),
    ).toBe('ok');

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let calls = 0;
    await expect(
      retry(
        w,
        'x',
        async () => (calls++, Promise.reject(abort)),
        () => 0,
      ),
    ).rejects.toBe(abort);
    expect(calls).toBe(1);
  });
});

describe('updatePolicy', () => {
  const backend = (failures: Error[] = []) => {
    let policy: Policy = { version: 3, etag: 'a', bindings: [] };
    const calls: { url: string; body: unknown }[] = [];
    return {
      calls,
      get policy() {
        return policy;
      },
      request: async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
        calls.push({ url, body });
        if (url.endsWith(':setIamPolicy')) {
          const failure = failures.shift();
          if (failure) throw failure;
          policy = { ...(body as { policy: Policy }).policy, etag: 'b' };
        }
        return policy as T;
      },
    };
  };

  const addViewer = (policy: Policy) =>
    policy.bindings?.length
      ? undefined
      : { ...policy, bindings: [{ role: 'roles/viewer', members: ['user:a@example.com'] }] };

  it('reads, changes, and writes back the policy with its version and etag', async () => {
    const google = backend();
    await updatePolicy(writer().w, google, {
      resource: 'https://x.test/p',
      getBody: { options: {} },
      label: 'p',
      change: addViewer,
    });
    expect(google.calls).toEqual([
      { url: 'https://x.test/p:getIamPolicy', body: { options: {} } },
      {
        url: 'https://x.test/p:setIamPolicy',
        body: {
          policy: { version: 3, etag: 'a', bindings: [{ role: 'roles/viewer', members: ['user:a@example.com'] }] },
        },
      },
    ]);
    await updatePolicy(writer().w, google, { resource: 'https://x.test/p', label: 'p', change: addViewer });
    expect(google.calls).toHaveLength(3);
  });

  it('retries conflicts with growing jittered delays', async () => {
    const google = backend([new HttpError(409, 'etag'), new Error('ABORTED: concurrent policy changes')]);
    const { w, sleeps } = writer();
    await updatePolicy(w, google, { resource: 'https://x.test/p', label: 'p', change: addViewer });
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThan(1500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[1]).toBeLessThan(2500);
  });

  it('retries 400 and 404 only for a just-created service account', async () => {
    const created = writer({ createdServiceAccount: true });
    await updatePolicy(created.w, backend([new HttpError(404, 'gone'), new HttpError(400, 'no member')]), {
      resource: 'https://x.test/p',
      label: 'p',
      change: addViewer,
    });
    expect(created.sleeps).toEqual([5000, 5000]);

    await expect(
      updatePolicy(writer().w, backend([new HttpError(400, 'no member')]), {
        resource: 'https://x.test/p',
        label: 'p',
        change: addViewer,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updatePolicy(created.w, backend([new HttpError(403, 'denied')]), {
        resource: 'https://x.test/p',
        label: 'p',
        change: addViewer,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
