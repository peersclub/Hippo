import { buildService } from './service.js'

const PORT = Number(process.env.PORT ?? 8793)

const app = buildService()
app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`seam on :${PORT} — canonical trading interface, sim venue adapter`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
