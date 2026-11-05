import { app, autoUpdater } from 'electron'
import { createServer } from 'node:http'
import { createReadStream, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.HEMI_ISOLATED_TEST_ROOT
app.setPath('userData', join(root, 'profile'))
const server = createServer((req, res) => {
  if (req.url === '/update.json') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/update.zip`, name: '1.0.1', notes: 'isolated self-signed test' }))
  } else if (req.url === '/update.zip') createReadStream(join(root, 'update.zip')).pipe(res)
  else { res.writeHead(404);res.end() }
})
const finish = (code, result) => {
  writeFileSync(join(root, 'native-result.json'), JSON.stringify(result))
  console.log(JSON.stringify(result))
  app.exit(code)
}
setTimeout(() => finish(2, { ok: false, reason: 'native updater deadline exceeded' }), 45000).unref()
app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', () => {
    autoUpdater.on('error', error => finish(1, { ok: false, reason: error.message }))
    autoUpdater.on('update-downloaded', () => finish(0, { ok: true, nativeSelfSignedUpdateAccepted: true }))
    autoUpdater.setFeedURL({ url: `http://127.0.0.1:${server.address().port}/update.json` })
    autoUpdater.checkForUpdates()
  })
})
