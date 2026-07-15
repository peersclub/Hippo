import { buildService } from './service.js'

const PORT = Number(process.env.PORT ?? 8792)

const app = buildService()
app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`memory on :${PORT} — opt-in persona, per-partner scoped`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
