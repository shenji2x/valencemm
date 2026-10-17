// Plays out one full deal between two fake agents and prints each step.
// Usage:  npm run demo                      (against http://localhost:8080)
//         node scripts/demo.js https://valencemm.com
const base = (process.argv[2] || process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");

async function call(method, path, key, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`\nFAILED: ${method} ${path} -> ${res.status}`, JSON.stringify(json));
    process.exit(1);
  }
  return json;
}

const step = (n, text) => console.log(`\n${n}. ${text}`);
const credits = async (name, key) => console.log(`   ${name} has ${(await call("GET", "/v1/me", key)).balance} credits`);

(async () => {
  console.log(`Running a demo deal against ${base} (play credits only)`);

  step(1, "Register a buyer and a seller");
  const buyer = await call("POST", "/v1/agents/register", null, { name: "demo-buyer" });
  const seller = await call("POST", "/v1/agents/register", null, { name: "demo-seller" });
  await credits("buyer", buyer.apiKey);
  await credits("seller", seller.apiKey);

  step(2, "Buyer creates a deal for 100 credits");
  const deal = await call("POST", "/v1/deals", buyer.apiKey, { title: "Demo job", amount: 100, role: "buyer", deadlineHours: 24 });
  console.log(`   deal ${deal.id} is "${deal.state}", invite code ${deal.inviteCode}`);

  step(3, "Seller joins with the invite code");
  const joined = await call("POST", "/v1/deals/join", seller.apiKey, { inviteCode: deal.inviteCode });
  console.log(`   deal is now "${joined.state}", seller sees their role as "${joined.yourRole}"`);

  step(4, "Buyer funds escrow");
  const funded = await call("POST", `/v1/deals/${deal.id}/fund`, buyer.apiKey);
  console.log(`   deal is now "${funded.state}", deadline ${funded.deadlineAt}`);
  await credits("buyer", buyer.apiKey);

  step(5, "Buyer releases the funds (seller gets 100 minus the 1% fee)");
  const released = await call("POST", `/v1/deals/${deal.id}/release`, buyer.apiKey);
  console.log(`   deal is now "${released.state}"`);
  await credits("buyer", buyer.apiKey);
  await credits("seller", seller.apiKey);

  const health = await call("GET", "/health");
  console.log(`\nDone. Ledger check: ${health.ledger}. Expected: buyer 0, seller 199.`);
})().catch((err) => {
  console.error(`\nCould not reach ${base}. Is the server running (npm start)?`, err.cause ? err.cause.code : err.message);
  process.exit(1);
});
