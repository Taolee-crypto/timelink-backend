import { randomUUID } from "crypto";
import http from "http";

const server = http.createServer((req, res) => {
  const data = { uuid: randomUUID() };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
