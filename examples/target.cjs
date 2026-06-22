/**
 * Demo target for inspectctl.
 *
 * Run with:   npm run target
 * Equivalent: node --inspect=9229 examples/target.cjs
 *
 * Exposes deliberate problems so you can demo inspectctl's tools:
 *   - leakyCache: a Map in closure that never frees, growing every 200ms
 *   - /buggy: handler with a deliberately corrupted config + breakpoint target
 *   - /cpu:   tight loop that maxes a core
 */
const http = require("node:http");

// --- leak: a Map in closure that nobody clears -----------------------------

function makeCache() {
  const cache = new Map();
  return {
    get: (k) => cache.get(k),
    set: (k, v) => cache.set(k, v),
    size: () => cache.size,
  };
}

const leakyCache = makeCache();
setInterval(() => {
  // Append a chunky entry every tick. heap_snapshot/heap_diff should catch this.
  const id = Date.now() + "-" + Math.random();
  leakyCache.set(id, new Array(1000).fill(id));
}, 200);

// --- silent config corruption ---------------------------------------------

const config = { region: "us-west", timeout: 5000, retries: 3 };
setInterval(() => {
  // Once in a while, mutate config in a way the app doesn't notice.
  if (Math.random() < 0.05) {
    config.timeout = -1;
  }
}, 1000);

// --- HTTP endpoints -------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/buggy") {
    handleBuggy(req, res);
    return;
  }
  if (req.url === "/cpu") {
    burnCpu(800);
    res.end("burned");
    return;
  }
  if (req.url === "/cache-size") {
    res.end(String(leakyCache.size()));
    return;
  }
  res.end("ok");
});

function handleBuggy(req, res) {
  const userId = req.headers["x-user-id"] || "anon"; // good breakpoint target
  const result = { userId, config, cacheSize: leakyCache.size() };
  res.end(JSON.stringify(result));
}

function burnCpu(ms) {
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end) {
    n = (n * 31 + 7) & 0xffffffff;
  }
  return n;
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`target listening on http://127.0.0.1:${PORT}`);
  console.log(`debugger should be on ws://127.0.0.1:9229/...`);
  console.log(`endpoints: /, /buggy, /cpu, /cache-size`);
});
