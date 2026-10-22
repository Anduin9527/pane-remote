import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clientIp, createHostCheck, createLease, deviceName } from '../lease.mjs'

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
// 测试地址用文档保留段拼出来（RFC 5737 / 6598），不写真实地址
const ip = (...p) => p.join('.')
const LOOP = ip(127, 0, 0, 1)
const HOST_TS = ip(100, 64, 0, 20) // 被遥控电脑的 tailnet 地址
const HOST_LAN = ip(192, 0, 2, 60) // 被遥控电脑的局域网地址
const PHONE = ip(100, 64, 0, 14)
const OTHER = ip(198, 51, 100, 7)

test('clientIp: direct peer, or last X-Forwarded-For only behind a loopback proxy', () => {
  assert.equal(clientIp(req('::ffff:' + PHONE)), PHONE)
  assert.equal(clientIp(req(PHONE, { 'x-forwarded-for': HOST_TS })), PHONE) // 非回环对端：代理头不可信
  assert.equal(clientIp(req(LOOP, { 'x-forwarded-for': `${OTHER}, ${HOST_TS}` })), HOST_TS)
})

test('host check: tailnet / LAN address of the controlled machine', () => {
  const hc = createHostCheck({ selfAddrs: () => [ip(203, 0, 113, 9)] })
  assert.equal(hc.isHost(req(HOST_TS)), false) // 还没收到上报：不拦
  hc.update({ addrs: ['fe80::1', HOST_LAN, HOST_TS, LOOP] })
  assert.equal(hc.isHost(req(HOST_TS)), true)
  assert.equal(hc.isHost(req(LOOP, { 'x-forwarded-for': HOST_LAN })), true) // tailscale serve / nginx 后面
  assert.equal(hc.isHost(req(PHONE)), false) // 手机
  assert.equal(hc.isHost(req(LOOP)), false) // 中转不在被遥控电脑上：回环是别的本机程序
})

test('host check: relay running on the controlled machine itself', () => {
  const hc = createHostCheck({ selfAddrs: () => [HOST_LAN] })
  hc.update({ addrs: [HOST_LAN] })
  assert.equal(hc.isHost(req(LOOP)), true)
  assert.equal(hc.isHost(req('::1')), true)
  assert.equal(hc.isHost(req(OTHER)), false)
})

test('host check: loopbackIsHost=false only trusts the proxy header', () => {
  const hc = createHostCheck({ loopbackIsHost: false, selfAddrs: () => [HOST_LAN] })
  hc.update({ addrs: [HOST_LAN, HOST_TS] })
  assert.equal(hc.isHost(req(LOOP)), false)
  assert.equal(hc.isHost(req(LOOP, { 'x-forwarded-for': HOST_TS })), true)
})

test('host check can be disabled', () => {
  const hc = createHostCheck({ allow: true, selfAddrs: () => [] })
  hc.update({ addrs: [HOST_TS] })
  assert.equal(hc.isHost(req(HOST_TS)), false)
})

test('lease: claim kicks other clients, holder persists across restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')), 'lease.json')
  const l = createLease({ file, log: () => {} })
  assert.equal(l.isHolder('phone-aaaaaaaa'), true) // 没人用过
  l.claim('phone-aaaaaaaa', 'iPhone')
  const kicked = []
  l.track('phone-aaaaaaaa', (i) => kicked.push(['phone', i.device]))
  l.track('pc-bbbbbbbbbbbb', (i) => kicked.push(['pc-old', i.device]))
  l.claim('pc-bbbbbbbbbbbb', 'desktop-pc')
  assert.deepEqual(kicked, [['phone', 'desktop-pc']]) // 自己的连接不踢
  assert.equal(l.isHolder('phone-aaaaaaaa'), false)
  // 二次顶号
  l.claim('phone-aaaaaaaa', 'iPhone')
  assert.equal(l.isHolder('pc-bbbbbbbbbbbb'), false)
  // 持久化
  const l2 = createLease({ file, log: () => {} })
  assert.equal(l2.isHolder('phone-aaaaaaaa'), true)
  assert.equal(l2.isHolder('pc-bbbbbbbbbbbb'), false)
})

test('lease: untrack removes the connection', () => {
  const l = createLease({ log: () => {} })
  l.claim('aaaaaaaa', 'A')
  let n = 0
  const untrack = l.track('bbbbbbbb', () => n++)
  untrack()
  l.claim('cccccccc', 'C')
  assert.equal(n, 0)
})

test('deviceName: tailscale node first, then user agent', () => {
  assert.equal(deviceName(req('x'), { name: 'desktop-pc' }), 'desktop-pc')
  assert.equal(deviceName(req('x', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36' })), 'Windows Chrome')
  assert.equal(deviceName(req('x', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1' })), 'iPhone')
})
