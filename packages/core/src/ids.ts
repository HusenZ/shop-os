/** Monotonic UUIDv7: time-ordered, generated offline, unique across devices. */
let lastMs = 0;
let seq = 0;

function hex(n: number, width: number) {
  return n.toString(16).padStart(width, '0');
}

export function uuidv7(nowMs: number = Date.now()): string {
  let ms = nowMs;
  if (ms <= lastMs) {
    ms = lastMs;
    seq++;
    if (seq > 0xfff) {
      ms = ++lastMs;
      seq = 0;
    }
  } else {
    lastMs = ms;
    seq = Math.floor(Math.random() * 0x400);
  }
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const msHex = hex(ms, 12);
  const ver = hex(0x7000 | seq, 4);
  const variant = hex((rand[0] & 0x3f) | 0x80, 2);
  const rest = Array.from(rand.slice(1), (b) => hex(b, 2)).join('');
  return `${msHex.slice(0, 8)}-${msHex.slice(8, 12)}-${ver}-${variant}${rest.slice(0, 2)}-${rest.slice(2, 14)}`;
}
