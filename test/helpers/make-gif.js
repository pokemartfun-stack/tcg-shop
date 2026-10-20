'use strict';
// Tiny animated-GIF writer for tests (no dependencies). Each frame is a solid palette colour.
// LZW trick: a CLEAR code every 2 pixels keeps the code size at 3 bits, so no real compression
// logic is needed. Output is a valid GIF89a that browsers, libvips/sharp and GIF tools read.
function makeAnimatedGif(width, height, frameColours, delayCs = 20) {
  const palette = [[0, 0, 0], [255, 204, 0], [229, 57, 53], [30, 136, 229]];
  const out = [];
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  out.push(...Buffer.from('GIF89a'), ...u16(width), ...u16(height), 0xf1, 0, 0); // GCT, 4 colours
  for (const c of palette) out.push(...c);
  out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0); // loop forever
  for (const colour of frameColours) {
    out.push(0x21, 0xf9, 4, 0x04, ...u16(delayCs), 0, 0); // graphic control: delay
    out.push(0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0); // image descriptor
    out.push(2); // LZW minimum code size
    const codes = [];
    const total = width * height;
    for (let i = 0; i < total; i++) {
      if (i % 2 === 0) codes.push(4); // CLEAR
      codes.push(colour);
    }
    codes.push(5); // EOI
    const bytes = [];
    let acc = 0, bits = 0;
    for (const code of codes) {
      acc |= code << bits; bits += 3;
      while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8; }
    }
    if (bits) bytes.push(acc & 255);
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}

module.exports = { makeAnimatedGif };
