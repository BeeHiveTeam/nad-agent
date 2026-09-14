/* wasCancelled, verbatim from main, against a socket whose close already fired. */
import http from "node:http";
import { once } from "node:events";
async function wasCancelled(socket) {
  return await Promise.race([
    once(socket, "close").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000).unref()),
  ]);
}
const srv = http.createServer((q, r) => r.end("{}"));
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
let captured = null, closeFired = false;
srv.on("connection", (s) => { if (!captured) { captured = s; s.once("close", () => { closeFired = true; }); } });
await fetch(`http://127.0.0.1:${srv.address().port}/`).then((r) => r.json());
captured.destroy();
await new Promise((r) => setTimeout(r, 50));
console.log(`close already fired: ${closeFired} | destroyed: ${captured.destroyed}`);
const t0 = Date.now();
const verdict = await wasCancelled(captured);
console.log(`wasCancelled -> ${verdict} after ${Date.now() - t0}ms   (correct answer: true, within a few ms)`);
srv.close(); process.exit(0);
