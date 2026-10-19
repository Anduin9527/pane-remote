// 测试 / bridge 用：发一行命令给 mousectl，打印它回的一行
import net from 'node:net'
import path from 'node:path'
const sock = process.env.VNC_PROXY_MOUSECTL || path.join(process.env.HOME, '.cache/pane-remote/mouse.sock')
const c = net.connect(sock, () => c.write(process.argv.slice(2).join(' ') + '\n'))
let buf = ''
c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { process.stdout.write(buf.slice(0, i + 1)); c.end() } })
c.on('error', (e) => { console.log(JSON.stringify({ error: 'mousectl: ' + e.code })); process.exit(1) })
setTimeout(() => { console.log(JSON.stringify({ error: 'mousectl timeout' })); process.exit(1) }, 15000).unref()
