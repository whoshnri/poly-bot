import app from "./server";

const port = Number(process.env.PORT ?? 3000);

console.log(`Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
