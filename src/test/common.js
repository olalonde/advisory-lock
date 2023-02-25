export const conString = process.env.PG_CONNECTION_STRING
  || 'postgres://127.0.0.1/test-advisorylock'

export const timeout = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

