import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCodexHome } from '../codex-home.mjs'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
  const home = path.join(root, 'home'), dir = path.join(root, 'state', 'codex-home')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  const real = path.join(home, '.codex', 'auth.json')
  fs.writeFileSync(real, '{"v":1}')
  return { home, dir, real, link: path.join(dir, 'auth.json'), ch: createCodexHome({ dir, home }) }
}
const later = (f, s) => fs.utimesSync(f, new Date(), new Date(Date.now() + s * 1000))

test('env() sets CODEX_HOME and links auth.json to the real login', () => {
  const { dir, real, link, ch } = setup()
  assert.equal(ch.env({ A: '1' }).CODEX_HOME, dir)
  assert.equal(fs.readlinkSync(link), real)
  assert.equal(fs.readFileSync(link, 'utf8'), '{"v":1}')
})

test('token refresh through the symlink lands in the real file', () => {
  const { real, link, ch } = setup()
  ch.env({})
  fs.writeFileSync(link, '{"v":2}') // 顺着软链写
  ch.reconcile()
  assert.equal(fs.readFileSync(real, 'utf8'), '{"v":2}')
  assert.ok(fs.lstatSync(link).isSymbolicLink())
})

test('write-temp-then-rename refresh is copied back and the link restored', () => {
  const { real, link, ch } = setup()
  ch.env({})
  fs.writeFileSync(link + '.tmp', '{"v":3}'); fs.renameSync(link + '.tmp', link) // 软链被换成普通文件
  later(link, 5)
  ch.reconcile()
  assert.equal(fs.readFileSync(real, 'utf8'), '{"v":3}')
  assert.equal((fs.statSync(real).mode & 0o777).toString(8), '600')
  assert.ok(fs.lstatSync(link).isSymbolicLink())
})

test('a stale copy does not overwrite a newer real login', () => {
  const { real, link, ch } = setup()
  ch.env({})
  fs.unlinkSync(link); fs.writeFileSync(link, '{"v":"old"}')
  fs.writeFileSync(real, '{"v":"new"}'); later(real, 10)
  ch.reconcile()
  assert.equal(fs.readFileSync(real, 'utf8'), '{"v":"new"}')
  assert.ok(fs.lstatSync(link).isSymbolicLink())
})

test('a leftover regular file is reconciled on the next env()', () => {
  const { real, link, ch } = setup()
  ch.env({})
  fs.unlinkSync(link); fs.writeFileSync(link, '{"v":4}'); later(link, 5)
  ch.env({}) // 上次进程被杀、没来得及 reconcile
  assert.equal(fs.readFileSync(real, 'utf8'), '{"v":4}')
  assert.ok(fs.lstatSync(link).isSymbolicLink())
})
