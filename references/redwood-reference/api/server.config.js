/**
 * This file allows you to configure the Fastify Server settings
 * used by the RedwoodJS dev server.
 *
 * It also applies when running RedwoodJS with `yarn rw serve`.
 *
 * For the Fastify server options that you can set, see:
 * https://www.fastify.io/docs/latest/Reference/Server/#factory
 *
 * Examples include: logger settings, timeouts, maximum payload limits, and more.
 *
 * Note: This configuration does not apply in a serverless deploy.
 */

/** @type {import('fastify').FastifyServerOptions} */
const config = {
  requestTimeout: 15_000,
  logger: {
    // Note: If running locally using `yarn rw serve` you may want to adjust
    // the default non-development level to `info`
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'warn',
  },
}

/**
 * You can also register Fastify plugins and additional routes for the API and Web sides
 * in the configureFastify function.
 *
 * This function has access to the Fastify instance and options, such as the side
 * (web, api, or proxy) that is being configured and other settings like the apiRootPath
 * of the functions endpoint.
 *
 * Note: This configuration does not apply in a serverless deploy.
 */

/** @type {import('@redwoodjs/api-server/dist/types').FastifySideConfigFn} */
const configureFastify = async (fastify, options) => {
  if (options.side === 'api') {
    fastify.log.trace({ custom: { options } }, 'Configuring api side')
  }

  if (options.side === 'web') {
    fastify.log.trace({ custom: { options } }, 'Configuring web side')
  }

  return fastify
}

module.exports = {
  config,
  configureFastify,
}
