const os = require('os')
const fs = require('fs')
const path = require('path')
const https = require('https')
const cp = require('child_process')
const StreamZip = require('node-stream-zip')
const packageJson = require('../package.json')

const isInteractive = process.stdout.isTTY
const colors = {
  red: (str) => `\x1b[31m${str}\x1b[0m`,
  green: (str) => `\x1b[32m${str}\x1b[0m`,
  yellow: (str) => `\x1b[33m${str}\x1b[0m`,
  cyan: (str) => `\x1b[36m${str}\x1b[0m`,
}

function updateLine(str) {
  if (isInteractive) {
    process.stdout.clearLine()
    process.stdout.cursorTo(0)
    if (str) {
      process.stdout.write(str)
    }
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Byte${bytes === 1 ? '' : 's'}`
  const magnitude = Math.floor(Math.log(bytes) / Math.log(1024))
  const fixed = (bytes / 1024 ** magnitude).toFixed(2)
  return `${Number(fixed)} ${'BKMGTPEZY'[magnitude]}iB`
}

function getCommandLineTool(name) {
  try {
    const command = `${name} --version`
    cp.execSync(command, { stdio: 'ignore' })
    return {
      name,
      version: cp
        .execSync(command)
        .toString()
        .trim(),
    }
  } catch (e) {
    return null
  }
}

async function create({ dest, user, repo, ref }) {
  if (!dest) {
    process.stderr.write(
      `Please specify the project directory:\n` +
        `  ${colors.cyan(packageJson.name)} ${colors.green('<project-directory>')}\n` +
        `\n` +
        `For example:\n` +
        `  ${colors.cyan(packageJson.name)} ${colors.green('my-app')}\n`,
    )
    return 1
  }

  const appPath = path.resolve(dest)
  const appName = path.basename(appPath)
  const restrictions = []

  // On Unix-like systems `/` is reserved and `<>:"/\|?*` on Windows.
  // https://msdn.microsoft.com/en-us/library/aa365247%28VS.85%29#naming_conventions
  if (/[<>:"/\\|?*]/.test(appName)) {
    restrictions.push('name cannot contain special characters (<>:"/\\|?*)')
  }

  if (/[\x00-\x1F]/.test(appName)) {
    restrictions.push('name cannot contain non-printable characters')
  }

  if (appName.length > 255) {
    restrictions.push('name cannot contain more than 255 characters')
  }

  if (appName !== appName.trim()) {
    restrictions.push('name cannot contain leading or trailing spaces')
  }

  if (restrictions.length > 0) {
    process.stderr.write(
      `Could not create a project called ${colors.red(JSON.stringify(appName))} ` +
        `because of the following naming restrictions:` +
        `\n${restrictions.map((str) => `  *  ${colors.red(str)}\n`).join('')}`,
    )
    return 2
  }

  const basePath = path.resolve(appPath, '..')

  if (!fs.existsSync(basePath)) {
    process.stderr.write(
      `Directory ${colors.red(JSON.stringify(basePath))} does not exist.\n` +
        `But you can create the project in the current directory like this:\n` +
        `  ${colors.cyan(packageJson.name)} ${colors.green(JSON.stringify(appName))}\n`,
    )
    return 3
  }

  if (fs.existsSync(appPath)) {
    const validFiles = ['.DS_Store', '.git', '.idea', 'Thumbs.db']
    const conflicts = fs.readdirSync(appPath).filter((file) => !validFiles.includes(file))
    if (conflicts.length > 0) {
      process.stderr.write(
        `The directory ${colors.green(JSON.stringify(appPath))} contains files` +
          ` that could conflict:\n` +
          `\n${conflicts.map((file) => `  ${colors.yellow(file)}\n`).join('')}\n` +
          `Either try using a new directory name, or remove the files listed above.\n`,
      )
      return 4
    }
  } else {
    fs.mkdirSync(appPath)
  }

  process.stdout.write(`Creating a new app in ${colors.green(JSON.stringify(appPath))}.\n`)

  const pkgManager = getCommandLineTool('yarn') || getCommandLineTool('npm')
  const publicUrl = `https://github.com/${user}/${repo}/tree/${ref}`
  const zipFile = path.resolve(os.tmpdir(), `github-${user}-${repo}-${ref}.zip`)
  const metaFile = path.resolve(os.tmpdir(), `github-${user}-${repo}-${ref}.json`)
  const tempFile = path.resolve(appPath, 'template.zip')
  let entryName = `${repo}-${ref}`
  let offline = false

  process.stdout.write(`\nDownloading project template from ${publicUrl}\n`)
  updateLine('Connecting...')

  await new Promise((resolve, reject) => {
    const options = {
      host: 'nodeload.github.com',
      path: `/${user}/${repo}/zip/${ref}`,
      headers: {
        'user-agent':
          `${packageJson.name}/${packageJson.version} ` +
          `node/${process.versions.node} ` +
          `${pkgManager ? `${pkgManager.name}/${pkgManager.version} ` : ''}` +
          `${process.platform} ${process.arch}`,
      },
    }
    const request = https.get(options, (response) => {
      if (response.statusCode !== 200) {
        reject(
          new Error(
            `Failed to load resource: ` +
              `the server responded with a status of ${response.statusCode} ` +
              `(${response.statusMessage}) https://${options.host}${options.path}`,
          ),
        )
        return
      }

      const entityTag = response.headers.etag
      try {
        if (entityTag && fs.existsSync(zipFile)) {
          const meta = JSON.parse(fs.readFileSync(metaFile, { encoding: 'utf8' }))
          if (meta.entityTag === entityTag) {
            entryName = meta.entryName
            request.abort()
            resolve()
            return
          }
        }
      } catch (err) {
        updateLine(`${colors.yellow('Warning: local cache is corrupted.')}\n`)
      }

      const file = fs.createWriteStream(tempFile)
      const size = parseInt(response.headers['content-length'], 10)
      let downloaded = 0

      file.on('error', reject)

      response.on('data', (chunk) => {
        downloaded += chunk.length
        file.write(chunk)

        if (size) {
          const percentage = ((downloaded / size) * 100).toFixed(0)
          updateLine(`Progress: ${percentage}% (${formatSize(downloaded)} / ${formatSize(size)})`)
        } else {
          updateLine(`Downloaded: ${formatSize(downloaded)}`)
        }
      })

      response.on('end', () => {
        file.end(() => {
          fs.renameSync(tempFile, zipFile)
          if (entityTag) {
            const header = response.headers['content-disposition']
            const match = header ? /filename="?([^;]+)\.zip/.exec(header) : null
            if (match) {
              entryName = match[1]
            }
            fs.writeFileSync(metaFile, JSON.stringify({ entityTag, entryName }))
          }
          resolve()
        })
      })
    })

    request.on('error', (error) => {
      try {
        const networkCodes = ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_FAIL']
        if (networkCodes.includes(error.code) && fs.existsSync(zipFile)) {
          const meta = JSON.parse(fs.readFileSync(metaFile, { encoding: 'utf8' }))
          entryName = meta.entryName
          offline = true
          updateLine(
            `\n${colors.yellow('Detected a problem with network connectivity.')}` +
              `\n${colors.yellow('Falling back to the local cache.')}\n\n`,
          )
          resolve()
          return
        }
      } catch (err) {
        reject(error)
        return
      }
      reject(error)
    })
  }).catch((error) => {
    updateLine(`${colors.red('Download failed! Please try again or download manually.')}\n\n`)
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile)
    }
    throw error
  })

  updateLine('Extracting...')

  await new Promise((resolve, reject) => {
    const zip = new StreamZip({ file: zipFile })
    let size = 0
    let files = 0

    zip.on('error', reject)

    zip.on('entry', (entry) => {
      if (!entry.isDirectory && entry.name.startsWith(entryName)) {
        files += 1
        size += entry.size
      }
    })

    zip.on('ready', () => {
      zip.extract(entryName, appPath, (err) => {
        if (err) {
          reject(err)
          return
        }

        zip.close(() => {
          updateLine(`Created ${files} files with total size of ${formatSize(size)}.\n`)
          resolve()
        })
      })
    })
  }).catch((error) => {
    updateLine(`${colors.red('Unzipping filed! Please try again or download manually.')}\n\n`)
    if (fs.existsSync(zipFile)) {
      fs.unlinkSync(zipFile)
    }
    throw error
  })

  let hasStart = false
  let hasBuild = false
  let hasTest = false

  await new Promise((resolve, reject) => {
    if (!pkgManager) {
      resolve()
      return
    }

    const dependencies = []

    try {
      const pkg = Object.assign({}, require(path.resolve(appPath, 'package.json')))
      Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies)).forEach(
        (dependencyName) => dependencies.push(dependencyName),
      )
      const pkgScripts = Object.assign({}, pkg.scripts)
      hasStart = 'start' in pkgScripts
      hasBuild = 'build' in pkgScripts
      hasTest = 'test' in pkgScripts
    } catch (err) {
      resolve()
      return
    }

    if (dependencies.length === 0) {
      resolve()
      return
    }

    process.stdout.write(
      `\nInstalling packages. This might take a couple of minutes.` +
        `\nInstalling ${dependencies.map((str) => colors.cyan(str)).join(', ')}...\n\n`,
    )

    const command = pkgManager.name
    const args = ['install', '--production=false']

    if (offline && command === 'yarn') {
      args.push('--offline')
    }

    const cmd = process.platform === 'win32' ? `${command}.cmd` : command
    const child = cp.spawn(cmd, args, {
      cwd: appPath,
      stdio: 'inherit',
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Child process "${command} ${args.join(' ')}" failed with code "${code}"`))
      }
    })
  })

  process.stdout.write(
    `\nSuccess! Created ${colors.green(JSON.stringify(appName))}` +
      ` at ${colors.green(JSON.stringify(appPath))}\n`,
  )

  if (pkgManager) {
    if (hasStart || hasBuild || hasTest) {
      process.stdout.write('Inside that directory, you can run several commands:\n\n')

      if (hasStart) {
        process.stdout.write(
          `  ${colors.cyan(pkgManager.name)} ${colors.cyan('start')}\n` +
            `    Starts the development server.\n\n`,
        )
      }

      if (hasBuild) {
        process.stdout.write(
          `  ${colors.cyan(pkgManager.name)} ${colors.cyan(
            pkgManager.name === 'yarn' ? 'build' : 'run build',
          )}\n    Optimizes the app for production.\n\n`,
        )
      }

      if (hasTest) {
        process.stdout.write(
          `  ${colors.cyan(pkgManager.name)} ${colors.cyan('test')}\n` +
            `    Starts the test runner.\n\n`,
        )
      }
    }

    if (hasStart) {
      process.stdout.write('We suggest that you begin by typing:\n\n')

      if (appPath !== process.cwd()) {
        const dir = /^[a-zA-Z0-9_-]+$/.test(dest) ? dest : JSON.stringify(dest)
        process.stdout.write(`  ${colors.cyan('cd')} ${dir}\n`)
      }

      process.stdout.write(`  ${colors.cyan(pkgManager.name)} ${colors.cyan('start')}\n\n`)
    }
  }

  process.stdout.write('Happy hacking!\n')
  return 0
}

module.exports = create
