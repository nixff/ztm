export default function (rootDir, mountName, epInfo, meshInfo, makeFilesystem) {
  rootDir = os.path.resolve(rootDir)

  var st = os.stat(rootDir)
  if (st) {
    if (!st.isDirectory()) {
      throw `directory path already exists as a regular file: ${rootDir}`
    }
  } else {
    os.mkdir(rootDir, { recursive: true })
  }

  pipy.mount(mountName, rootDir)

  function listRecursive(path, base, list) {
    os.readDir(path).forEach(name => {
      if (name.endsWith('/')) {
        listRecursive(
          os.path.join(path, name),
          os.path.join(base, name),
          list
        )
      } else {
        list.push(os.path.join(base, name))
      }
    })
  }

  function listProviders() {
    return os.readDir(rootDir)
      .filter(name => name.endsWith('/'))
      .map(name => name.substring(0, name.length - 1))
  }

  function listDownloaded(provider) {
    var dirname = os.path.join(rootDir, provider)
    return os.readDir(dirname).filter(name => {
      if (name.startsWith('.') || !name.endsWith('/')) return false
      if (os.stat(os.path.join(dirname, name, 'main.js'))?.isFile?.()) {
        return true
      }
      return false
    }).map(
      name => name.substring(0, name.length - 1)
    )
  }

  function listRunning() {
    return apps.filter(app => app.isRunning()).map(
      app => ({
        name: app.appname,
        provider: app.provider,
        username: app.username,
      })
    )
  }

  function isDownloaded(provider, appname) {
    var dirname = os.path.join(rootDir, provider, appname)
    var st = os.stat(dirname)
    if (!st?.isDirectory?.()) return false
    if (
      !os.stat(os.path.join(dirname, 'main.js'))?.isFile?.() &&
      !os.stat(os.path.join(dirname, 'main.ztm.js'))?.isFile?.()
    ) return false
    return true
  }

  function isRunning(provider, appname) {
    var app = findApp(provider, appname)
    return app ? app.isRunning() : false
  }

  function pack(provider, appname) {
    var dirname = os.path.join(rootDir, provider, appname)
    var filenames = []
    listRecursive(dirname, '/', filenames)

    if (filenames.length === 0) {
      return Promise.reject('No files to pack')
    }

    filenames.sort()

    var outputBuffer = new Data

    var encodeFile = pipeline($=>$
      .onStart(path => new MessageStart({ method: 'POST', path }))
      .replaceStreamEnd(new MessageEnd)
      .encodeHTTPRequest()
      .handleData(data => outputBuffer.push(data))
      .replaceMessage(new StreamEnd)
    )

    function packFile() {
      if (filenames.length == 0) {
        return Promise.resolve(outputBuffer)
      }
      var filename = filenames.shift()
      var fullpath = os.path.join(dirname, filename)
      return pipy.read(fullpath, encodeFile, filename).then(packFile)
    }

    return packFile()
  }

  function unpack(provider, appname, data) {
    remove(provider, appname)
    var dirname = os.path.join(rootDir, provider, appname)
    return pipeline($=>$
      .onStart([data, new StreamEnd])
      .decodeHTTPRequest()
      .handleMessage(msg => {
        var path = os.path.normalize(msg.head.path)
        path = os.path.join(dirname, path)
        os.mkdir(os.path.dirname(path), { recursive: true, force: true })
        os.write(path, msg.body)
      })
    ).spawn()
  }

  var apps = []

  function findApp(provider, appname) {
    return apps.find(
      a => a.appname === appname && (!provider || a.provider === provider)
    )
  }

  function start(provider, appname, username) {
    var app = findApp(provider, appname)
    if (!app) {
      app = App(provider, appname, username)
      apps.push(app)
    }
    app.start()
  }

  function stop(provider, appname) {
    var app = findApp(provider, appname)
    if (app) {
      app.stop()
    }
  }

  function connect(provider, appname) {
    var app = findApp(provider, appname)
    return app ? app.connect() : null
  }

  function log(provider, appname) {
    var app = findApp(provider, appname)
    return app ? app.log() : null
  }

  function remove(provider, appname) {
    stop(provider, appname)
    var dirname = os.path.join(rootDir, provider, appname)
    os.rmdir(dirname, { recursive: true, force: true })
  }

  function App(provider, appname, username) {
    var appRootDir = os.path.join('/', mountName, provider, appname)
    var appLog = []
    var entryPipeline = null
    var exitCallbacks = []

    function start() {
      if (entryPipeline) return
      var mainFunc = pipy.import(os.path.join(appRootDir, 'main.js')).default
      if (typeof mainFunc !== 'function') throw `The default export from ${provider}/${appName} main script is not a function`
      entryPipeline = mainFunc({
        app: {
          name: appname,
          provider,
          username,
          endpoint: { ...epInfo },
          log,
          onExit,
        },
        mesh: {
          ...meshInfo,
          ...makeFilesystem(provider, appname),
        },
      })
    }

    function stop() {
      exitCallbacks.forEach(f => {
        try { f() } catch {}
      })
      entryPipeline = null
    }

    function log(msg) {
      if (appLog.length > 100) {
        appLog.splice(0, appLog.length - 100)
      }
      appLog.push({
        time: new Date().toISOString(),
        message: msg,
      })
    }

    function onExit(cb) {
      if (typeof cb !== 'function') throw 'onExit() expects a function as argument'
      exitCallbacks.push(cb)
    }

    return {
      provider,
      appname,
      username,
      start,
      stop,
      isRunning: () => Boolean(entryPipeline),
      connect: () => entryPipeline,
      log: () => appLog,
    }
  }

  return {
    listProviders,
    listDownloaded,
    listRunning,
    isDownloaded,
    isRunning,
    pack,
    unpack,
    start,
    stop,
    connect,
    log,
    remove,
  }
}
