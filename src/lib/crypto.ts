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

// --- 多 gateway key（D-06/D-07）：按 gatewayId 索引 AES cipher，沿用同一 passphrase ---

export function gatewayKeyStorageId(gatewayId: string): string {
  return `councilkit.gateways.${gatewayId}.enc`;
}

export function saveGatewayApiKey(gatewayId: string, plain: string): void {
  localStorage.setItem(gatewayKeyStorageId(gatewayId), encryptApiKey(plain));
}

export function loadGatewayApiKey(gatewayId: string): string | null {
  const cipher = localStorage.getItem(gatewayKeyStorageId(gatewayId));
  if (!cipher) return null;
  try {
    const plain = decryptApiKey(cipher);
    // Crypto-js decrypt of corrupt cipher may yield "" instead of throwing;
    // treat empty result as missing key (real API keys are non-empty).
    return plain.length === 0 ? null : plain;
  } catch {
    return null;
  }
}

export function clearGatewayApiKey(gatewayId: string): void {
  localStorage.removeItem(gatewayKeyStorageId(gatewayId));
}
