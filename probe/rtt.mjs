/* Loopback round-trip, cold vs warm — the number the #95 fixture deadline has to clear. */
import http from "node:http";
const srv = http.createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end('{"items":[]}'); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
for (let i = 0; i < 5; i++) {
  const t = process.hrtime.bigint();
  await fetch(base + "/w").then((r) => r.json());
  console.log(`rtt ${i + 1}: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms${i === 0 ? "   <- cold" : ""}`);
}
srv.close(); process.exit(0);
