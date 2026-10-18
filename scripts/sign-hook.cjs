// scripts/sign-hook.cjs —— 唯一的签名实现位置（后端待定）
/**
 * @param {string} filePath 待签名文件
 * 要求：Authenticode SHA-256 + RFC 3161 时间戳；签名后执行 `signtool verify /pa`，失败则抛错
 */
module.exports = async function sign(filePath) {
  const backend = process.env.WIN_SIGN_BACKEND;
  if (!backend) {
    console.warn(`[sign] WIN_SIGN_BACKEND not set, skip: ${filePath}`);
    return;
  }
  switch (backend) {
    // case 'remote':  调用自建签名服务
    // case 'azure':   signtool + Azure Trusted Signing
    // case 'cloudhsm': signtool / jsign + 云 HSM 证书
    default:
      throw new Error(`[sign] unsupported WIN_SIGN_BACKEND: ${backend}`);
  }
};
