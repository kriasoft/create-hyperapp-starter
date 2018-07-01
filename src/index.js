#!/usr/bin/env node

const currentNodeVersion = process.versions.node
const semver = currentNodeVersion.split('.')
const major = semver[0]

if (major < 8) {
  process.stderr.write(
    `\x1b[31m` + // red
      `You are running Node ${currentNodeVersion}.\n` +
      `Hyperapp Create requires Node 8 or higher.\n` +
      `Please update your version of Node.\x1b[0m\n`,
  )
  process.exit(1)
}

process.on('unhandledRejection', (error) => {
  throw error
})

const dest = process.argv[2]
const user = 'frenzzy'
const repo = 'hyperapp-starter'
const ref = 'template'
const create = require('./create')

create({ dest, user, repo, ref }).then((code) => {
  process.exit(code)
})
