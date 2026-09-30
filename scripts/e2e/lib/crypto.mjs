// 与前端一致的 AES 加解密（前端 assets 中硬编码的公开参数，非密钥秘密）：
//   请求加密：AES-256-ECB(Pkcs7)，key = UTF8('cfdeec6bb693b85c8808a6fc47172832')，输出 base64
//   响应解密：同上，key = '039e10f88123a2b9963f24a3e2254353'
//   请求头：X-Api-Encrypt: true
import crypto from 'node:crypto'

export const REQ_KEY = 'cfdeec6bb693b85c8808a6fc47172832'
export const RESP_KEY = '039e10f88123a2b9963f24a3e2254353'
export const ENCRYPT_HEADER = 'X-Api-Encrypt'

function cipher (plain, keyStr) {
  const c = crypto.createCipheriv('aes-256-ecb', Buffer.from(keyStr, 'utf8'), null)
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64')
}

function decipher (b64, keyStr) {
  const d = crypto.createDecipheriv('aes-256-ecb', Buffer.from(keyStr, 'utf8'), null)
  return Buffer.concat([d.update(b64, 'base64'), d.final()]).toString('utf8')
}

/** 加密请求体（对象或字符串）→ base64，与前端 u0.encryptRequest 等价 */
export function encryptRequest (data) {
  const plain = typeof data === 'string' ? data : JSON.stringify(data)
  return cipher(plain, REQ_KEY)
}

/** 解密响应体（base64 字符串）→ 对象或字符串，与前端 u0.decryptResponse 等价 */
export function decryptResponse (text) {
  const plain = decipher(text, RESP_KEY)
  try { return JSON.parse(plain) } catch { return plain }
}
