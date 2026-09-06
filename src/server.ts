import { createApp } from "./app.ts"

const server = createApp()

server.listen(3000, "0.0.0.0", () => {
  console.log("Shipyard listening on http://0.0.0.0:3000")
})
