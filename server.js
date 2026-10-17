const { createApp } = require("./src/app");

const port = process.env.PORT || 8080;
const server = createApp();
server.listen(port, () => {
  console.log(`Listening on ${port}`);
  console.log(`Test credits: ${server.testCodesEnabled ? "enabled" : "off (set TEST_CREDIT_CODES to turn on)"}`);
});

// Cloud Run sends SIGTERM before stopping an instance.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
