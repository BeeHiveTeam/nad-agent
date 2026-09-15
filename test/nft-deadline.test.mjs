/**
 * get_nfts must return when the indexer stalls (Issue #94).
 *
 * The deadline added in #93 covers the explorer reads behind `/history`; the Reservoir path
 * behind `get_nfts` was a separate call with no deadline at all, so a stalled indexer kept the
 * agent waiting with nothing to show and no way to give up.
 *
 * These run against a real loopback server rather than a fetch double on purpose, the same way
 * the history deadline is tested: a double that ignores `signal` looks exactly like one that
 * honours it, so only a real connection can show that the request was actually cancelled and
 * not merely abandoned by a resolved promise.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

// config.mjs reads the environment once at import time, so the indexer host and key have to be
// in place BEFORE wallet.mjs loads — otherwise every case here fails on the missing-key refusal
// instead of exercising the deadline. The runner gives each test file its own process, so this
// affects nothing else. Values are placeholders: the fixture below re-points the host anyway.
process.env.RESERVOIR_API_URL ||= "https://indexer.invalid";
process.env.RESERVOIR_API_KEY ||= "test-key";
const { getNfts } = await import("../src/wallet.mjs");

const OWNER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

const TOKEN_PAGE = {
  tokens: [
    {
      token: {
        contract: "0x3333333333333333333333333333333333333333",
        tokenId: "7",
        name: "Test token",
        collection: { name: "Test collection" },
      },
    },
  ],
};

/**
 * `stalledSockets` holds the socket each stalled request arrived on; aborting the request
 * destroys it, which is how the test tells cancellation apart from "we stopped waiting".
 * `fetchImpl` only re-points the host, so production code still builds its own URL and the
 * real fetch and abort paths run.
 */
async function indexerFixture({ mode = "ok" } = {}) {
  const stalledSockets = [];
  const server = http.createServer((req, res) => {
    if (mode === "headers") {
      stalledSockets.push(req.socket); // never answers at all
      return;
    }
    if (mode === "body") {
      stalledSockets.push(req.socket);
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.write('{"tokens":'); // headers fine, body never finishes
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(TOKEN_PAGE));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    stalledSockets,
    fetchImpl: (url, opts) => fetch(base + new URL(url).pathname + new URL(url).search, opts),
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * A cancelled request's socket closes a tick after the call rejects, so this waits for the
 * close rather than sampling `destroyed` and racing it. An uncancelled request never closes,
 * which is the failure this has to report rather than hang on.
 */
async function wasCancelled(socket) {
  return Promise.race([
    once(socket, "close").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000).unref()),
  ]);
}

/** A deadline that never fires would hang the suite: `npm test` sets no per-test timeout. */
async function expectTimeout(promise) {
  const outcome = await Promise.race([
    promise.then(() => ({ resolved: true }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 3000).unref()),
  ]);
  assert.equal(outcome.hung, undefined, "get_nfts hung: the deadline never fired");
  assert.equal(outcome.resolved, undefined, "get_nfts resolved although the indexer never answered");
  return outcome.error;
}

describe("get_nfts deadline", () => {
  it("gives up when the indexer never sends headers, and cancels the request", async () => {
    const fx = await indexerFixture({ mode: "headers" });
    try {
      const error = await expectTimeout(getNfts(OWNER, { fetchImpl: fx.fetchImpl, timeoutMs: 120 }));
      assert.match(error.message, /NFT read timed out after 120ms/);
      assert.equal(await wasCancelled(fx.stalledSockets[0]), true, "the stalled request was not cancelled");
    } finally {
      fx.close();
    }
  });

  it("gives up when the body stalls after the headers arrive", async () => {
    // The case a header-only timeout would miss: the response starts, then never ends.
    const fx = await indexerFixture({ mode: "body" });
    try {
      const error = await expectTimeout(getNfts(OWNER, { fetchImpl: fx.fetchImpl, timeoutMs: 120 }));
      assert.match(error.message, /NFT read timed out after 120ms/);
      assert.equal(await wasCancelled(fx.stalledSockets[0]), true, "the stalled body was not cancelled");
    } finally {
      fx.close();
    }
  });

  it("reads an ordinary answer and leaves no timer behind", async () => {
    const fx = await indexerFixture({ mode: "ok" });
    try {
      const page = await getNfts(OWNER, { fetchImpl: fx.fetchImpl, timeoutMs: 5000 });
      assert.equal(page.tokens.length, 1);
      assert.equal(page.tokens[0].tokenId, "7");
      // A 5s timer left pending would hold the event loop open well past this test; the suite
      // finishing at all is the assertion, and this makes the intent explicit.
      const pending = process.getActiveResourcesInfo().filter((r) => r === "Timeout");
      assert.equal(pending.length, 0, "the deadline timer outlived a successful read");
    } finally {
      fx.close();
    }
  });

  it("treats a nonsense deadline as the default rather than as no deadline", async () => {
    // Number("") is 0 and setTimeout(NaN) fires immediately: either would fail every read.
    const fx = await indexerFixture({ mode: "ok" });
    try {
      const page = await getNfts(OWNER, { fetchImpl: fx.fetchImpl, timeoutMs: Number.NaN });
      assert.equal(page.tokens.length, 1);
    } finally {
      fx.close();
    }
  });
});
