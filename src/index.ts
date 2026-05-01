import app from "./server";

const port = Number(6060);

console.log(`Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};