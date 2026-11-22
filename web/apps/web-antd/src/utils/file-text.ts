/**
 * 导入用文件读取（台账页与对话上传共用）。
 * UTF-8 优先；解不动时回落 GBK——中文 Excel「另存为 CSV」默认是 GBK 编码，
 * 硬按 UTF-8 解会得到整表乱码、列头全崩（对抗审查 P2-4）。
 */
export async function readFileText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      // 个别浏览器没有 GBK 解码器：退回非严格 UTF-8（可能乱码，但至少能进预览看到）
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

/** 工作区文件名归一：浏览器下载/聊天工具传出的文件名常带空格，白名单不收，替换成下划线。 */
export function safeFileName(name: string): string {
  return name.trim().replaceAll(/\s+/g, '_');
}
