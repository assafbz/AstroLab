import { createApp } from "./server.js";

const port = Number(process.env.API_PORT ?? 8080);

createApp().listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
