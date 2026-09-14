import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { getHistory, normalizeHistoryTransaction } from "../src/wallet.mjs";
import { config } from "../src/config.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"a".repeat(64)}`;

describe("normalizeHistoryTransaction", () => {
  it("normalizes an incoming explorer transaction", () => {
    assert.deepEqual(
      normalizeHistoryTransaction({ hash: HASH, from: { hash: OTHER }, to: { hash: OWNER }, value: "42" }, OWNER),
      {
        hash: HASH,
        direction: "in",
        amount: 42n,
        timestamp: null,
        explorerUrl: `${config.chain.explorerUrl}/tx/${HASH}`,
      },
    );
  });

  it("normalizes an outgoing internal transaction", () => {
    const result = normalizeHistoryTransaction(
      { transaction_hash: HASH, from: OWNER, to: OTHER, value: "0x2a", timestamp: "2026-08-24T12:00:00Z" },
      OWNER,
    );
    assert.equal(result.direction, "out");
    assert.equal(result.amount, 42n);
    assert.equal(result.hash, HASH);
  });

  it("ignores transactions unrelated to the account", () => {
    assert.equal(normalizeHistoryTransaction({ hash: HASH, from: OTHER, to: OTHER, value: "1" }, OWNER), null);
  });

  it("ignores records without a transaction hash", () => {
    assert.equal(normalizeHistoryTransaction({ from: OWNER, to: OTHER, value: "1" }, OWNER), null);
  });
});

describe("getHistory", () => {
  it("combines explorer transactions and internal transactions newest first", async () => {
    const incomingHash = `0x${"b".repeat(64)}`;
    const outgoingHash = `0x${"c".repeat(64)}`;
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      const internal = url.endsWith("/internal-transactions");
      return {
        ok: true,
        async json() {
          return { items: internal
            ? [{ transaction_hash: outgoingHash, from: OWNER, to: OTHER, value: "20", timestamp: "2026-08-24T12:00:00Z" }]
            : [{ hash: incomingHash, from: { hash: OTHER }, to: { hash: OWNER }, value: "10", timestamp: "2026-08-24T13:00:00Z" }] };
        },
      };
    };

    const result = await getHistory({ ownerAddress: OWNER, fetchImpl });
    assert.deepEqual(result.map(({ hash, direction, amount }) => ({ hash, direction, amount })), [
      { hash: incomingHash, direction: "in", amount: 10n },
      { hash: outgoingHash, direction: "out", amount: 20n },
    ]);
    assert.equal(requested.length, 2);
  });

  it("uses the endpoint that succeeds when the other explorer endpoint fails", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/internal-transactions")) return { ok: false, status: 404, statusText: "Not Found" };
      return {
        ok: true,
        async json() {
          return { items: [{ hash: HASH, from: OTHER, to: OWNER, value: "1" }] };
        },
      };
    };
    const result = await getHistory({ ownerAddress: OWNER, fetchImpl });
    assert.equal(result.length, 1);
    assert.equal(result[0].hash, HASH);
  });

  it("applies the requested result limit", async () => {
    const items = [1, 2, 3].map((value) => ({
      hash: `0x${String(value).repeat(64)}`,
      from: OTHER,
      to: OWNER,
      value: String(value),
      timestamp: `2026-08-24T1${value}:00:00Z`,
    }));
    const fetchImpl = async (url) => ({
      ok: true,
      async json() { return { items: url.endsWith("/internal-transactions") ? [] : items }; },
    });
    const result = await getHistory({ ownerAddress: OWNER, limit: 2, fetchImpl });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((tx) => tx.amount), [3n, 2n]);
  });
});

/**
 * A stand-in for MonadScan, one mode per endpoint:
 *
 *   "ok"      answers instantly, in process
 *   "headers" never responds at all
 *   "body"    sends headers and an opening brace, then never finishes the body
 *
 * Only a stalled endpoint goes over a real connection, because cancellation is the one
 * thing a hand-written double cannot show: a double that ignores `signal` looks exactly
 * like one that honours it. An answered endpoint has nothing to prove that way, so it is
 * a plain double and returns without touching the network — which is what keeps these
 * tests off the clock. The healthy half used to race the fixture deadline over loopback,
 * and on the CI Windows image that race is what went red.
 *
 * `stalledSockets` holds the socket each stalled request arrived on; aborting the request
 * destroys it, and that is the assertion the real connection exists for.
 */
async function explorerFixture({ transactions = "ok", internal = "ok", items = [], overNetwork = false } = {}) {
  const stalledSockets = [];
  const stalls = overNetwork || transactions !== "ok" || internal !== "ok";
  let server = null;
  let base = "";
  if (stalls) {
    server = http.createServer((req, res) => {
      if (req.url.startsWith("/ok")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: req.url.endsWith("/internal") ? [] : items }));
        return;
      }
      // Everything else routed here is a stall, so every arrival is one to record.
      stalledSockets.push(req.socket);
      if (req.url.startsWith("/body")) {
        res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
        res.write('{"items":');
      }
      // "/headers": no response at all, not even a status line.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }
  return {
    stalledSockets,
    fetchImpl: (url, opts) => {
      const internalPath = url.includes("/internal-transactions");
      const mode = internalPath ? internal : transactions;
      if (mode !== "ok") return fetch(`${base}/${mode}`, opts);
      // Only the transactions endpoint carries rows, so a result of one proves which half
      // of the history survived rather than just counting to one.
      if (overNetwork) return fetch(`${base}/ok${internalPath ? "/internal" : ""}`, opts);
      return Promise.resolve({
        ok: true,
        async json() {
          return { items: internalPath ? [] : items };
        },
      });
    },
    close() {
      server?.closeAllConnections();
      server?.close();
    },
  };
}

/**
 * A cancelled request's socket is destroyed a tick after `getHistory` resolves, so this
 * waits for the close rather than sampling and racing it. The close may equally have
 * happened already, and subscribing to an event that is past reports a cancelled request
 * as uncancelled after burning the whole timeout — so the settled state is checked first.
 * An uncancelled request never closes, which is the failure this has to report rather
 * than hang on.
 */
async function wasCancelled(socket) {
  if (socket.destroyed) return true;
  return await Promise.race([
    once(socket, "close").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000).unref()),
  ]);
}

/**
 * A deadline that never fires makes the call under test hang, and a hung test reports
 * nothing at all — `npm test` sets no per-test timeout, so CI would sit on it. Bound the
 * wait here so the failure is a red assertion naming the missing deadline.
 */
async function settlesWithin(promise, ms, message) {
  promise.catch(() => {}); // the losing side of the race must not surface as unhandled
  const outcome = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve(null), ms).unref()),
  ]);
  assert.ok(outcome, message);
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

const INCOMING = {
  hash: `0x${"d".repeat(64)}`,
  from: { hash: OTHER },
  to: { hash: OWNER },
  value: "7",
  timestamp: "2026-09-12T00:00:00Z",
};

/**
 * The deadline the stall tests hand to `getHistory`. It no longer has to beat a healthy
 * response — those are answered in process now — but a stalled request still has to reach
 * the server before it expires, or there is no socket left to assert on. 500 ms is twenty
 * times the slowest first request measured on the CI runner images (23.5 ms on
 * windows-latest, 21.2 ms on ubuntu-latest) and eight times under the absolute bound
 * below, which is what still turns a missing production deadline into a prompt failure
 * rather than a hang.
 */
const STALL_DEADLINE_MS = 500;
/** Absolute, so it does not move with the deadline it is meant to catch the absence of. */
const SETTLE_BOUND_MS = 4000;

describe("getHistory — request deadlines", () => {
  it("returns the healthy endpoint's history when the other never sends headers", async () => {
    const fixture = await explorerFixture({ internal: "headers", items: [INCOMING] });
    try {
      const result = await settlesWithin(
        getHistory({ ownerAddress: OWNER, fetchImpl: fixture.fetchImpl, timeoutMs: STALL_DEADLINE_MS }),
        SETTLE_BOUND_MS,
        "a stalled endpoint must not keep /history waiting",
      );
      assert.equal(result.length, 1);
      assert.equal(result[0].hash, INCOMING.hash);
      // The point of the deadline is not that we stopped waiting but that the request is
      // gone: a stalled request left open holds a socket on the explorer side too.
      assert.equal(fixture.stalledSockets.length, 1);
      assert.ok(await wasCancelled(fixture.stalledSockets[0]), "the timed-out request must be cancelled, not abandoned");
    } finally {
      fixture.close();
    }
  });

  it("returns the healthy endpoint's history when the other stalls mid-body", async () => {
    // Headers arrive, so a deadline that only covered the response headers would consider
    // this request finished and wait forever on `res.json()`.
    const fixture = await explorerFixture({ internal: "body", items: [INCOMING] });
    try {
      const result = await settlesWithin(
        getHistory({ ownerAddress: OWNER, fetchImpl: fixture.fetchImpl, timeoutMs: STALL_DEADLINE_MS }),
        SETTLE_BOUND_MS,
        "a deadline that ends at the headers leaves the body read hanging",
      );
      assert.equal(result.length, 1);
      assert.equal(result[0].hash, INCOMING.hash);
      assert.ok(await wasCancelled(fixture.stalledSockets[0]), "the timed-out body read must be cancelled");
    } finally {
      fixture.close();
    }
  });

  it("reports a request cancelled before the check as cancelled, without waiting", async () => {
    // On a fast machine the socket is already gone when the assertion runs. Subscribing to
    // a close that has passed reported a cancelled request as uncancelled, and only after
    // the full wait, so the observer has to read the settled state before it waits.
    const server = http.createServer((req, res) => res.end("{}"));
    let captured = null;
    server.on("connection", (socket) => { captured ??= socket; });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      await fetch(`http://127.0.0.1:${server.address().port}/`).then((res) => res.json());
      captured.destroy();
      await once(captured, "close");

      const started = Date.now();
      assert.equal(await wasCancelled(captured), true, "a closed socket is a cancelled request");
      assert.ok(Date.now() - started < 100, "the answer must not wait out an event that is past");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("fails with both endpoints named when neither answers", async () => {
    const fixture = await explorerFixture({ transactions: "headers", internal: "body" });
    try {
      await assert.rejects(
        settlesWithin(
          getHistory({ ownerAddress: OWNER, fetchImpl: fixture.fetchImpl, timeoutMs: STALL_DEADLINE_MS }),
          SETTLE_BOUND_MS,
          "two stalled endpoints must still fail the command",
        ),
        (err) => {
          // Rejecting rather than resolving is the whole of the scripted exit code: an
          // empty list takes cli.mjs:417 instead, which prints "no recent transactions
          // found" and returns without setting hadFailure — a total outage would read as
          // an empty history and exit 0. The message matters too, since that is what
          // cli.mjs prints, and a rejection naming only the first endpoint hid half of it.
          assert.match(err.message, /transactions —/);
          assert.match(err.message, /internal transactions —/);
          assert.match(err.message, new RegExp(`timed out after ${STALL_DEADLINE_MS}ms`));
          return true;
        },
      );
    } finally {
      fixture.close();
    }
  });

  it("leaves no deadline armed once the requests are done", async () => {
    // The timer outliving the request would keep the event loop alive after `/history`
    // returned, delaying a scripted run's exit by the length of the deadline.
    const pending = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const fixture = await explorerFixture({ items: [INCOMING] });
    try {
      const before = pending();
      await getHistory({ ownerAddress: OWNER, fetchImpl: fixture.fetchImpl, timeoutMs: 60_000 });
      assert.ok(pending() <= before, "a settled request must not leave its deadline armed");
    } finally {
      fixture.close();
    }
  });

  it("ignores a deadline that is not a usable number instead of timing out at once", async () => {
    // setTimeout treats NaN as "fire now": taken literally, an unusable deadline would
    // cancel every history request rather than none of them.
    //
    // This one endpoint has to answer over a real connection, because an instant double
    // resolves before an abort could reach it and the fallback would go untested. There is
    // no race here to be flaky about: when the fallback works the budget is the full 10 s
    // default, and when it is gone the abort fires at once regardless of how fast the
    // response is.
    const fixture = await explorerFixture({ items: [INCOMING], overNetwork: true });
    try {
      for (const timeoutMs of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, "soon", null]) {
        const result = await getHistory({ ownerAddress: OWNER, fetchImpl: fixture.fetchImpl, timeoutMs });
        assert.equal(result.length, 1, `timeoutMs=${String(timeoutMs)} must fall back to the default`);
      }
    } finally {
      fixture.close();
    }
  });
});
