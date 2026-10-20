// The browser solves puzzles with its own SHA-256 (public/app.js). Run that exact code here and check
// the server accepts what it finds, so the two can never drift apart.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createPow, leadingZeroBits } = require("../src/pow");

function loadBrowserSolver() {
  const src = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = src.indexOf("// ---- pow:start ----");
  const end = src.indexOf("// ---- pow:end ----");
  assert.ok(start > 0 && end > start, "pow markers missing from public/app.js");
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function("TextEncoder", `${body}; return { solvePuzzle, shaBlock, shaZeroBits, SHA_IV };`)(TextEncoder);
}

test("the browser's solver finds answers the server accepts", async () => {
  const { solvePuzzle } = loadBrowserSolver();
  const pow = createPow();
  for (const scope of ["signup", "agent", "login"]) {
    for (let i = 0; i < 4; i++) {
      const c = pow.issue(scope, 10);
      const solution = await solvePuzzle(c.challenge, 10);
      assert.doesNotThrow(() => pow.verify(c.challenge, solution, scope, 10));
    }
  }
});

test("the browser's SHA-256 matches Node's for messages that span one, two and three blocks", () => {
  const { shaBlock, SHA_IV } = loadBrowserSolver();
  function browserDigest(text) {
    const msg = new TextEncoder().encode(text);
    const total = Math.ceil((msg.length + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const bits = msg.length * 8;
    buf[total - 4] = bits >>> 24; buf[total - 3] = (bits >>> 16) & 255; buf[total - 2] = (bits >>> 8) & 255; buf[total - 1] = bits & 255;
    const H = new Uint32Array(SHA_IV);
    for (let off = 0; off < total; off += 64) shaBlock(H, buf, off);
    return [...H].map((w) => w.toString(16).padStart(8, "0")).join("");
  }
  for (const len of [0, 1, 55, 56, 63, 64, 119, 120, 150, 200]) {
    const text = "x".repeat(len) + ":" + len;
    assert.equal(browserDigest(text), crypto.createHash("sha256").update(text).digest("hex"), `length ${len}`);
  }
  assert.equal(leadingZeroBits(Buffer.from([0, 0x0f])), 12);
});
