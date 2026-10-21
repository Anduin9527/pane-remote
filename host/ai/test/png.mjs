// 零依赖生成小 PNG（冒烟测试用，不截屏）：白底，左边一个色块，右边用 5×7 点阵写几个字符
import zlib from 'node:zlib'

const FONT = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

export function makePng({ text = 'HI 42', square = [220, 30, 30], scale = 6 } = {}) {
  const pad = 8
  const sq = 7 * scale
  const w = pad + sq + pad + text.length * 6 * scale + pad
  const h = pad * 2 + 7 * scale
  const px = Buffer.alloc(w * h * 3, 255)
  const set = (x, y, [r, g, b]) => { const i = (y * w + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b }
  for (let y = 0; y < sq; y++) for (let x = 0; x < sq; x++) set(pad + x, pad + y, square)
  ;[...text].forEach((ch, ci) => {
    const g = FONT[ch] || FONT[' ']
    const ox = pad + sq + pad + ci * 6 * scale
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1')
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(ox + c * scale + dx, pad + r * scale + dy, [0, 0, 0])
  })
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
