var CHUNK_SIZE = 2*1024*1024
var DOWNLOAD_CONCURRENCY = 5

//
// Cloud view:
//   /users
//     /<username>
//       ...
//
// In the local directory:
//   /users/<username>/...  <-- Identical to the cloud view
//   /cache/<username>/
//     {
//       time: 1789123456789,
//       size: 1024,
//       hash: [
//         '0123456789abcdef',
//         '0123456789abcdef',
//       ]
//     }
//   /download/<username>/
//     <filename>.all
//     <filename>.<num>
//
// On the mesh:
//   /shared/<username>/stat/
//     {
//       time: 1789123456789,
//       size: 1024,
//       hash: [
//         '0123456789abcdef',
//         '0123456789abcdef',
//       ]
//     }
//   /shared/<username>/hash/
//     <filename>.all
//     <filename>.<num>
//

export default function ({ app, mesh }) {
  var localDir

  applyConfig()

  function applyConfig() {
    return getLocalConfig().then(
      config => {
        localDir = config.localDir
        if (localDir.startsWith('~/')) {
          localDir = os.home() + localDir.substring(1)
        }
      }
    )
  }

  function allEndpoints() {
    return mesh.discover()
  }

  function getEndpointConfig(ep) {
    if (ep === app.endpoint.id) {
      return getLocalConfig()
    } else {
      return mesh.request(ep, new Message(
        {
          method: 'GET',
          path: `/api/config`,
        }
      )).then(res => res ? JSON.decode(res.body) : null)
    }
  }

  function setEndpointConfig(ep, config) {
    if (ep === app.endpoint.id) {
      return setLocalConfig(config)
    } else {
      return mesh.request(ep, new Message(
        {
          method: 'POST',
          path: `/api/config`,
        },
        JSON.encode(config)
      )).then(res => {
        var status = res?.head?.status
        if (!(200 <= status && status <= 299)) throw res.head.statusText
      })
    }
  }

  function getLocalConfig() {
    return mesh.read('/local/config.json').then(
      data => {
        try {
          var config = JSON.decode(data) || {}
        } catch {
          var config = {}
        }
        config.localDir ??= '~/ztmCloud'
        config.mirrors ??= []
        return config
      }
    )
  }

  function setLocalConfig(config) {
    mesh.write('/local/config.json', JSON.encode(config))
    return applyConfig()
  }

  var matchPathUser = new http.Match('/users/{username}')
  var matchPathUserFile = new http.Match('/users/{username}/*')
  var matchPathChunk = new http.Match('/api/chunks/*')

  var downloadQueue = []
  var downloadFiles = {}
  var downloadLanes = []
  var downloadError = {}
  var uploadFiles = {}

  function continueDownloading() {
    var vacantLanes = DOWNLOAD_CONCURRENCY - downloadLanes.length
    new Array(vacantLanes).fill().forEach(() => {
      var file = downloadQueue[0]
      if (file) {
        var chunk = file.chunks.shift()
        if (file.chunks.length === 0) {
          downloadQueue.shift()
        }
        if (chunk) {
          downloadLanes.push(chunk)
          var path = chunk[0]
          var hash = chunk[1]
          var params = matchPathUserFile(path)
          var username = params.username
          var filename = params['*']
          var pathname = os.path.join('/shared', username, 'hash', filename)
          mesh.stat(pathname).then(
            stat => downloadChunk(path, hash, stat?.sources || [])
          )
        }
      }
    })
  }

  function downloadChunk(path, hash, sources) {
    if (sources.length === 0) {
      app.log(downloadError[path] = `Chunk ${path} not found`)
      return finalizeChunk(path)
    }
    var i = path.lastIndexOf('.')
    var filename = path.substring(0,i)
    var chunkNum = path.substring(i+1)
    var outputPath = os.path.join(localDir, 'download', path)
    os.mkdir(os.path.dirname(outputPath), { recursive: true })
    var ep = sources.splice(Math.floor(Math.random() * sources.length), 1)[0]
    var downloaded = null
    app.log(`Downloading chunk ${path}...`)
    return pipeline($=>$
      .onStart(
        new Message({
          method: 'GET',
          path: os.path.join('/api/chunks', filename) + '?chunk=' + chunkNum,
        })
      )
      .muxHTTP().to($=>$
        .pipe(mesh.connect(ep))
      )
      .replaceMessage(res => {
        var status = res?.head?.status
        if (status === 200) {
          downloaded = res.body
        } else {
          app.log(`Downloading ${filename} from ep ${ep} returned status ${status}`)
        }
        return new StreamEnd
      })
    ).spawn().then(() => {
      if (!downloaded) return
      os.write(outputPath, downloaded)
      var hasher = new crypto.Hash('sha256')
      return pipy.read(outputPath, $=>$
        .handleData(data => hasher.update(data))
      ).then(() => hasher.digest('hex'))
    }).then(h => {
      if (h === hash) {
        return finalizeChunk(path)
      } else {
        app.log(`Chunk ${path} from ep ${ep} was corrupt`)
        return downloadChunkFrom(path, hash, sources)
      }
    })
  }

  function finalizeChunk(path) {
    var i = path.lastIndexOf('.')
    var filename = path.substring(0, i)
    var f = downloadFiles[filename]
    if (f && f.chunks.length === 0) {
      return finalizeDownload(filename).then(() => {
        clearDownload(filename)
        delete downloadFiles[filename]
        delete downloadError[filename]
        next()
      })
    }
    function next() {
      downloadLanes = downloadLanes.filter(([p]) => p !== path)
      continueDownloading()
    }
    next()
    return Promise.resolve()
  }

  function finalizeDownload(filename) {
    var i = 0
    var outputFilename = os.path.join(localDir, filename)
    var inputFilename = os.path.join(localDir, 'download', filename + '.0')
    if (!os.stat(inputFilename)?.isFile?.()) return Promise.resolve()
    return pipeline($=>$
      .onStart(new Data)
      .repeat(() => {
        inputFilename = os.path.join(localDir, 'download', `${filename}.${++i}`)
        return os.stat(inputFilename)?.isFile?.()
      }).to($=>$
        .read(() => inputFilename)
        .replaceStreamStart(evt => [new MessageStart, evt])
        .replaceStreamEnd(new MessageEnd)
        .mux().to($=>$
          .tee(outputFilename)
        )
        .replaceMessageEnd(new StreamEnd)
      )
    ).spawn()
  }

  function clearDownload(filename) {
    var basename = os.path.basename(filename)
    var dirname = os.path.dirname(filename)
    var dir = os.path.join(localDir, 'download', dirname)
    os.readDir(dir).forEach(
      name => {
        var i = name.lastIndexOf('.')
        if (name.substring(0, i) === basename) {
          os.rm(os.path.join(dir, name))
        }
      }
    )
  }

  function getFileStat(pathname) {
    pathname = os.path.normalize(pathname)
    if (pathname === '/') return Promise.resolve(['users/'])
    if (pathname === '/users') return getUserList()
    var params = matchPathUser(pathname)
    if (params) return getFileListByUser(params.username)
    var params = matchPathUserFile(pathname)
    if (params) return getFileStatByUser(params.username, params['*'])
    return Promise.resolve(null)
  }

  function getUserList() {
    return mesh.dir('/shared').then(
      meshNames => {
        var s = new Set
        var list = []
        os.readDir(os.path.join(localDir, 'users')).concat(meshNames).forEach(
          name => {
            var k = name.endsWith('/') ? name.substring(0, name.length - 1) : name
            if (!s.has(k)) {
              s.add(k)
              list.push(name)
            }
          }
        )
        return list.sort()
      }
    )
  }

  function getFileListByUser(username) {
    return mesh.dir(os.path.join('/shared', username, 'stat')).then(
      meshNames => {
        var s = new Set
        var list = []
        os.readDir(os.path.join(localDir, 'users', username)).concat(meshNames).forEach(
          name => {
            var k = name.endsWith('/') ? name.substring(0, name.length - 1) : name
            if (!s.has(k)) {
              s.add(k)
              list.push(name)
            }
          }
        )
        return list.sort()
      }
    )
  }

  function getFileStatByUser(username, filename) {
    return Promise.all([
      getLocalStat(username, filename),
      mesh.read(os.path.join('/shared', username, 'stat', filename)).then(data => data ? JSON.decode(data) : getMeshDir(username, filename)),
      mesh.stat(os.path.join('/shared', username, 'hash', filename + '.all')),
    ]).then(
      ([statEndp, statMesh, statHash]) => {
        if (statEndp instanceof Array) {
          if (statMesh instanceof Array) {
            var s = new Set
            var l = []
            statEndp.concat(statMesh).forEach(
              name => {
                var k = name.endsWith('/') ? name.substring(0, name.length - 1) : name
                if (!s.has(k)) {
                  s.add(k)
                  l.push(name)
                }
              }
            )
          }
          return l.sort()
        } else if (statMesh instanceof Array) {
          statMesh = null
        }
        if (!statEndp && !statMesh) return null
        var timeEndp = statEndp?.time || 0
        var timeMesh = statMesh?.time || 0
        var time = 0
        var size = 0
        var hash = null
        var state = 'synced'
        if (
          statEndp?.size !== statMesh?.size ||
          statEndp?.hash?.length !== statMesh?.hash?.length ||
          statEndp?.hash?.some?.((h, i) => (h !== statMesh?.hash?.[i]))
        ) {
          if (timeEndp < timeMesh) {
            time = timeMesh
            size = statMesh.size
            hash = statMesh.hash
            state = statEndp ? 'outdated' : 'missing'
          } else {
            time = timeEndp
            size = statEndp.size
            hash = statEndp.hash
            state = statMesh ? 'changed' : 'new'
          }
        } else {
          time = timeMesh
          size = statEndp.size
          hash = statEndp.hash
        }
        var path = os.path.join('/users', username, filename)
        var stat = {
          path,
          state,
          size,
          time,
          hash,
          sources: statHash?.sources || [],
        }
        if (path in downloadFiles) {
          var f = downloadFiles[path]
          var n = Math.ceil(f.size / CHUNK_SIZE)
          stat.downloading = (n - f.chunks.length) / n
        }
        return stat
      }
    )
  }

  function listDownloads() {
    return Promise.resolve(
      Object.keys(downloadFiles)
    )
  }

  function listUploads() {
    return Promise.resolve(
      Object.keys(uploadFiles)
    )
  }

  function downloadFile(pathname) {
    pathname = os.path.normalize(pathname)
    if (pathname in downloadFiles) return Promise.resolve(true)
    if (pathname in uploadFiles) return Promise.resolve(false)
    var params = matchPathUserFile(pathname)
    if (!params) return Promise.resolve(false)
    var username = params.username
    var filename = params['*']
    return mesh.read(os.path.join('/shared', username, 'stat', filename)).then(
      data => {
        if (!data) return false
        if (pathname in downloadFiles) return true
        var statMesh = JSON.decode(data)
        var file = {
          path: pathname,
          size: statMesh.size,
          chunks: statMesh.hash.map((hash, i) => [`${pathname}.${i}`, hash])
        }
        downloadFiles[pathname] = file
        downloadQueue.push(file)
        continueDownloading()
        return true
      }
    )
  }

  function uploadFile(pathname) {
    pathname = os.path.normalize(pathname)
    if (pathname in uploadFiles) return Promise.resolve(true)
    if (pathname in downloadFiles) return Promise.resolve(false)
    var params = matchPathUserFile(pathname)
    if (!params) return Promise.resolve(false)
    var username = params.username
    var filename = params['*']
    var meshStatPath = os.path.join('/shared', username, 'stat', filename)
    var meshHashPath = os.path.join('/shared', username, 'hash', filename)
    return getFileStatByUser(username, filename).then(
      statLocal => {
        if (!statLocal) return false
        if (statLocal instanceof Array) return false
        if (statLocal.state === 'synced') return true
        if (statLocal.state !== 'changed' && statLocal.state !== 'new') return false
        var stat = {
          time: statLocal.time,
          size: statLocal.size,
          hash: statLocal.hash,
        }
        uploadFiles[pathname] = stat
        mesh.write(meshStatPath, JSON.encode(stat))
        mesh.write(meshHashPath + '.all', stat.hash.join('\n'))
        var queue = [...stat.hash]
        function writeHash(i) {
          if (queue.length > 0) {
            return mesh.write(`${meshHashPath}.${i}`, queue.shift()).then(
              () => writeHash(i + 1)
            )
          } else {
            delete uploadFiles[pathname]
            return true
          }
        }
        return writeHash(0)
      }
    )
  }

  function getLocalStat(username, filename) {
    var localPathname = os.path.join(localDir, 'users', username, filename)
    var cachePathname = os.path.join(localDir, 'cache', username, filename)
    try {
      var statLocal = os.stat(localPathname)
      var statCache = JSON.decode(os.read(cachePathname))
    } catch {}
    if (!statLocal) return Promise.resolve(null)
    if (statLocal.isDirectory()) return os.readDir(localPathname)
    var time = Math.floor(statLocal.mtime * 1000)
    if (!statCache || statCache.time !== time) {
      var chunks = []
      var hasher = new crypto.Hash('sha256')
      var hashSize = 0
      var fileSize = 0

      function append(chunk) {
        hashSize += chunk.size
        fileSize += chunk.size
        hasher.update(chunk)
        if (hashSize === CHUNK_SIZE) {
          chunks.push(hasher.digest('hex'))
          hasher = new crypto.Hash('sha256')
          hashSize = 0
        }
      }

      return pipy.read(localPathname, $=>$
        .handleData(data => {
          append(data.shift(CHUNK_SIZE - hashSize))
          new Array(Math.floor(data.size / CHUNK_SIZE)).fill().forEach(
            () => append(data.shift(CHUNK_SIZE))
          )
          if (data.size > 0) append(data)
        })
      ).then(() => {
        if (hashSize > 0) {
          chunks.push(hasher.digest('hex'))
        }
        var stat = { time, size: fileSize, hash: chunks }
        try {
          os.mkdir(os.path.dirname(cachePathname), { recursive: true })
          os.write(cachePathname, JSON.encode(stat))
        } catch (err) {
          app.log(`cannot cache file stat for ${os.path.join('/', username, filename)}: ${err.message}`)
        }
        return stat
      })
    } else {
      return Promise.resolve(statCache)
    }
  }

  function getMeshDir(username, filename) {
    var pathname = os.path.join('/shared', username, 'stat', filename)
    return mesh.dir(pathname)
  }

  var $ctx

  var serveChunk = pipeline($=>$
    .onStart(c => { $ctx = c })
    .pipe(
      function (req) {
        if (req instanceof MessageStart) {
          var params = matchPathChunk(req.head.path)
          if (!params) return serveChunkReject
          var url = new URL(req.head.path)
          var chunkNum = url.searchParams.get('chunk')
          if (!chunkNum) return serveChunkReject
          var filename = '/' + params['*']
          if (!matchPathUserFile(filename)) return serveChunkReject
          var path = os.path.join(localDir, filename)
          var seek = Number.parseInt(chunkNum) * CHUNK_SIZE
          return pipeline($=>$
            .read(path, { seek, size: CHUNK_SIZE })
            .replaceStreamStart(evt => [new MessageStart, evt])
            .replaceStreamEnd(evt => [new MessageEnd, evt])
          )
        }
      }
    )
  )

  var serveChunkReject = pipeline($=>$
    .replaceData()
    .replaceMessage(new Message({ status: 404 }))
  )

  return {
    allEndpoints,
    getEndpointConfig,
    setEndpointConfig,
    getFileStat,
    listDownloads,
    listUploads,
    downloadFile,
    uploadFile,
    serveChunk,
  }
}
