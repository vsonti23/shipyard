import { once } from "node:events"
import { expect, test } from "vitest"
import { createApp } from "./app.ts"

test("GET /health returns a healthy response", async () => {
  const server = createApp()

  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const address = server.address()

    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address")
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.json()).toEqual({
      status: "ok",
      service: "shipyard",
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })

      server.closeAllConnections()
    })
  }
})
