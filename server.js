const { createApp } = require("./src/app");

const port = process.env.PORT || 8080;
const server = createApp().listen(port, () => {
  console.log(`Listening on ${port}`);
});

// Cloud Run sends SIGTERM before stopping an instance.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
