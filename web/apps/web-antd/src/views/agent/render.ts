/**
 * 对话页的轻量消息渲染：先整体转义防 XSS，再处理财务台回复实际用到的
 * 少量 markdown（**加粗**、- 列表、1. 列表、换行）。不引 markdown-it——
 * 等真需要全量 markdown 再评估依赖。
 */

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderMessage(text: string): string {
  const safe = escapeHtml(text);
  const lines = safe.split('\n');
  const out: string[] = [];
  let list: 'ol' | 'ul' | undefined;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = undefined;
  };
  for (const line of lines) {
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1]!)}</li>`);
    } else if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1]!)}</li>`);
    } else {
      closeList();
      out.push(line.trim() === '' ? '' : `<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.filter(Boolean).join('');
}

/** 行内格式：**加粗** 与 `代码`。 */
function inline(s: string): string {
  return s
    .replaceAll(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replaceAll(/`([^`]+)`/g, '<code>$1</code>');
}
