/**
 * @vitest-environment jsdom
 */
/**
 * Regression: the AgeGateCheckbox must re-fetch when its `refreshNonce`
 * prop changes, not only on the initial check / interval / visibility
 * tick. This is the recovery path the click-time stale-token check in
 * AccountControl + Transfer dialog depends on.
 *
 * The previous behaviour ignored consumer-side null-out of the local
 * token state, so a stale click could leave the buttons disabled and
 * the "click again in a moment" note showing forever.
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { AgeGateCheckbox } from '../../lab/js/components/AgeGateCheckbox';

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ ageIntent: 'token-' + Math.random(), ttlSeconds: 300 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
});

interface RecorderHandle {
  bumpRefresh: () => void;
  uncheck: () => void;
  intents: Array<{ token: string | null; mintedAt: number | null }>;
}

function Harness({ onReady }: { onReady: (h: RecorderHandle) => void }) {
  const [checked, setChecked] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Ref so the array survives re-renders — a fresh `[]` on each render
  // would lose any intent already pushed by a prior render's callback.
  const intentsRef = React.useRef<RecorderHandle['intents']>([]);
  React.useEffect(() => {
    onReady({
      bumpRefresh: () => setRefreshNonce((n) => n + 1),
      uncheck: () => setChecked(false),
      intents: intentsRef.current,
    });
    setChecked(true);
  }, [onReady]);
  return (
    <AgeGateCheckbox
      checked={checked}
      onCheckedChange={setChecked}
      onAgeIntent={(token, mintedAt) => intentsRef.current.push({ token, mintedAt })}
      refreshNonce={refreshNonce}
      idSuffix="test"
    />
  );
}

describe('AgeGateCheckbox refreshNonce', () => {
  it('refetches when refreshNonce increments', async () => {
    let handle!: RecorderHandle;
    render(<Harness onReady={(h) => { handle = h; }} />);

    // Wait for initial fetch + the intent to propagate to the consumer.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(handle.intents.some((i) => i.token !== null)).toBe(true);
    });
    const initialToken = handle.intents.filter((i) => i.token !== null).at(-1)!.token;
    expect(initialToken).toMatch(/^token-/);

    // Simulate the consumer's stale-click path: the consumer would null
    // its local copy AND bump refreshNonce. The bump is what must
    // trigger a fresh fetch — without it, the component would stay
    // idle until the next 4-min tick.
    act(() => { handle.bumpRefresh(); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    // A second bump triggers a third fetch.
    act(() => { handle.bumpRefresh(); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));

    // The new tokens propagate to the consumer.
    const lastWithToken = handle.intents.filter((i) => i.token !== null).at(-1);
    expect(lastWithToken?.token).toMatch(/^token-/);
    expect(lastWithToken?.mintedAt).toBeTypeOf('number');
  });

  it('clears fetching synchronously when unchecked mid-refresh (no stuck spinner)', async () => {
    // Replace the spy with a delayed fetch so we have a real in-flight
    // request to interrupt by unchecking.
    let resolveFetch: ((res: Response) => void) | null = null;
    const slowFetch = vi.fn(() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    globalThis.fetch = slowFetch as unknown as typeof fetch;

    const fetching: boolean[] = [];
    let captured!: { uncheck: () => void };
    function Wrapper() {
      const [checked, setChecked] = useState(false);
      React.useEffect(() => {
        captured = { uncheck: () => setChecked(false) };
        setChecked(true);
      }, []);
      return (
        <AgeGateCheckbox
          checked={checked}
          onCheckedChange={setChecked}
          onAgeIntent={() => {}}
          onFetchingChange={(f) => fetching.push(f)}
          idSuffix="uncheck"
        />
      );
    }
    render(<Wrapper />);

    // Wait until the in-flight fetch flips fetching to true.
    await waitFor(() => expect(fetching.at(-1)).toBe(true));

    // Uncheck mid-refresh — the in-flight `.finally(setFetching(false))`
    // is gated by `cancelled`, so the synchronous reset in the
    // unchecked branch is what must drive fetching back to false.
    act(() => { captured.uncheck(); });
    await waitFor(() => expect(fetching.at(-1)).toBe(false));

    // Resolving the now-orphaned fetch must NOT bring fetching back.
    act(() => {
      resolveFetch?.(
        new Response(JSON.stringify({ ageIntent: 'late', ttlSeconds: 300 }), {
          status: 200,
        }),
      );
    });
    // Give microtasks a chance to flush so a regression would be caught.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetching.at(-1)).toBe(false);
  });

  it('reports fetching=true while a refresh is in flight', async () => {
    const fetching: boolean[] = [];
    let captured!: { bumpRefresh: () => void };
    function Wrapper() {
      const [checked, setChecked] = useState(false);
      const [refreshNonce, setRefreshNonce] = useState(0);
      React.useEffect(() => {
        captured = { bumpRefresh: () => setRefreshNonce((n) => n + 1) };
        setChecked(true);
      }, []);
      return (
        <AgeGateCheckbox
          checked={checked}
          onCheckedChange={setChecked}
          onAgeIntent={() => {}}
          onFetchingChange={(f) => fetching.push(f)}
          refreshNonce={refreshNonce}
          idSuffix="test2"
        />
      );
    }
    render(<Wrapper />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetching).toContain(true);
    await waitFor(() => expect(fetching.at(-1)).toBe(false));

    // A bumped refresh produces another true→false sequence.
    const beforeBump = fetching.length;
    act(() => { captured.bumpRefresh(); });
    await waitFor(() => expect(fetching.length).toBeGreaterThan(beforeBump));
    expect(fetching.slice(beforeBump)).toContain(true);
  });
});
