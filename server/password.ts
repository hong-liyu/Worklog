const encoder = new TextEncoder()

export const PBKDF2_ITERATIONS = 600_000
const AUTH_SALT_PREFIX = 'worklog:'
const AUTH_HASH_BYTES = 32

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * 浏览器端把密码派生成 authHash 再上传。PBKDF2 的开销落在设备上，
 * 服务端只做一次 SHA-256，避免穿透 Workers 免费版的 10ms CPU 限额。
 */
export async function deriveAuthHash(
  password: string,
  username: string,
  iterations: number = PBKDF2_ITERATIONS
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(`${AUTH_SALT_PREFIX}${username}`), iterations, hash: 'SHA-256' },
    key,
    AUTH_HASH_BYTES * 8
  )
  return toBase64(new Uint8Array(bits))
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function randomSalt(bytes = 16): string {
  let hex = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(bytes))) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** 库里只存 sha256(salt:authHash)，即使拖库也拿不到可复用的 authHash。 */
export function hashPassword(authHash: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${authHash}`)
}
