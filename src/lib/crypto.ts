import CryptoJS from "crypto-js";

const STORAGE_KEY = "councilkit.key.enc";
// 派生密钥: 浏览器内固定 passphrase（本地单用户，详见 TECH 安全边界）。
const PASSPHRASE = "councilkit-local-v1";

export function encryptApiKey(plain: string): string {
  return CryptoJS.AES.encrypt(plain, PASSPHRASE).toString();
}

export function decryptApiKey(cipher: string): string {
  const bytes = CryptoJS.AES.decrypt(cipher, PASSPHRASE);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function saveApiKey(raw: string): void {
  localStorage.setItem(STORAGE_KEY, encryptApiKey(raw));
}

export function loadApiKey(): string | null {
  const cipher = localStorage.getItem(STORAGE_KEY);
  if (!cipher) return null;
  try {
    return decryptApiKey(cipher);
  } catch {
    return null;
  }
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
