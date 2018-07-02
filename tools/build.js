process.env.BABEL_ENV = 'production'
process.env.NODE_ENV = 'production'
process.on('unhandledRejection', (error) => {
  throw error
})

const fs = require('fs-extra')
const babel = require('@babel/core')
const prettier = require('prettier')
const pkg = require('../package.json')

function transformFile(src, dist, targets) {
  return new Promise((resolve, reject) => {
    babel.transformFile(
      src,
      {
        babelrc: false,
        comments: false,
        compact: true,
        presets: [['@babel/preset-env', { targets, useBuiltIns: 'entry', loose: true }]],
        plugins: [
          [
            'module-resolver',
            {
              resolvePath(sourcePath) {
                return sourcePath === '../package.json' ? './package.json' : sourcePath
              },
            },
          ],
        ],
      },
      async (error, result) => {
        if (error) {
          reject(error)
          return
        }

        const options = await prettier.resolveConfig(src)

        fs.writeFile(
          dist,
          prettier.format(result.code, { ...options, filepath: src }),
          'utf8',
          (err) => (err ? reject(err) : resolve()),
        )
      },
    )
  })
}

async function build() {
  // Clean up the output directory
  await fs.emptyDir('dist')

  // Copy readme and license
  await Promise.all([
    fs.copy('README.md', 'dist/README.md'),
    fs.copy('LICENSE.md', 'dist/LICENSE.md'),
  ])

  // Compile source code into a distributable format with Babel
  await transformFile('src/index.js', 'dist/index.js', { node: '0.1' })
  await transformFile('src/create.js', 'dist/create.js', { node: '8.3' })

  // Create package.json for npm publishing
  const libPkg = { ...pkg }
  delete libPkg.private
  delete libPkg.devDependencies
  delete libPkg.scripts
  libPkg.bin['hyperapp-create'] = './index.js'
  await fs.outputJson('dist/package.json', libPkg, { spaces: 2 })
}

module.exports = build()
