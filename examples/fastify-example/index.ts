import fastify from 'fastify'
import { TriggerDevFastifyPlugin } from '@trigger.dev/fastify'
import { client } from './trigger'

const server = fastify()

server.register(TriggerDevFastifyPlugin, {
    tiggerDevClient: client,
})

server.listen({ port: 3000 }, (err, address) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log(`Server listening at ${address}`)
})