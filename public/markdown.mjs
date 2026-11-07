const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) => escaped[character]);
const word = (character) => Boolean(character && /[\p{L}\p{N}]/u.test(character));

function safeLink(destination) {
  const match = destination.trim().match(/^<?([^\s<>]+)>?(?:\s+["'][^\n]*["'])?$/);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function inline(source, depth = 0) {
  if (depth > 12) return escapeHtml(source);
  let html = '';
  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && /[\\`*{}\[\]()#+\-.!_>~|]/.test(source[i + 1] || '')) {
      html += escapeHtml(source[i + 1]); i += 2; continue;
    }
    if (source[i] === '`') {
      const marker = source.slice(i).match(/^`+/)[0];
      const end = source.indexOf(marker, i + marker.length);
      if (end !== -1) {
        html += `<code>${escapeHtml(source.slice(i + marker.length, end).replace(/\n/g, ' '))}</code>`;
        i = end + marker.length; continue;
      }
      html += marker; i += marker.length; continue;
    }
    if (source[i] === '[' || source.startsWith('![', i)) {
      const image = source[i] === '!';
      const match = source.slice(i + Number(image)).match(/^\[([^\[\]\n]*)\]\(([^()\n]*)\)/);
      if (match) {
        const label = inline(match[1], depth + 1);
        const href = safeLink(match[2]);
        html += image || !href ? label : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        i += match[0].length + Number(image); continue;
      }
    }
    const marker = ['***', '___', '**', '__', '~~', '*', '_'].find((token) => source.startsWith(token, i));
    if (marker && !(marker.includes('_') && word(source[i - 1]) && word(source[i + marker.length]))) {
      let end = source.indexOf(marker, i + marker.length);
      if (marker.length === 2 && source.startsWith(marker + marker[0], end)) end++;
      const content = end < 0 ? '' : source.slice(i + marker.length, end);
      if (content && /^\S[\s\S]*$/.test(content) && /\S$/.test(content)) {
        const tag = marker === '~~' ? 'del' : marker.length === 1 ? 'em' : 'strong';
        const inside = inline(content, depth + 1);
        html += marker.length === 3 ? `<strong><em>${inside}</em></strong>` : `<${tag}>${inside}</${tag}>`;
        i = end + marker.length; continue;
      }
    }
    html += escapeHtml(source[i]);
    i++;
  }
  return html;
}

const fence = (line) => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
const heading = (line) => line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
const rule = (line) => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
const list = (line) => {
  const match = line.match(/^( *)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/);
  return match ? { indent: match[1].length, ordered: /^\d/.test(match[2]), number: parseInt(match[2], 10), text: match[3] } : null;
};
const blockStart = (line) => fence(line) || heading(line) || rule(line) || list(line) || /^ {0,3}>/.test(line);

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function tableStart(lines, i) {
  return lines[i]?.includes('|') && lines[i + 1]?.includes('|') &&
    cells(lines[i + 1]).every((cell) => /^:?-{3,}:?$/.test(cell)) &&
    cells(lines[i]).length === cells(lines[i + 1]).length;
}

function blocks(lines, depth = 0) {
  if (depth > 12) return `<p>${escapeHtml(lines.join('\n'))}</p>`;
  let html = '';
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const code = fence(line);
    if (code) {
      const contents = [];
      const endFence = new RegExp(`^ {0,3}${code[1][0]}{${code[1].length},}[ \\t]*$`);
      i++;
      while (i < lines.length && !endFence.test(lines[i])) contents.push(lines[i++]);
      if (i < lines.length) i++;
      const language = code[2].trim().split(/\s+/)[0];
      html += `<pre>${language ? `<span class="code-label">${escapeHtml(language)}</span>` : ''}<code>${escapeHtml(contents.join('\n'))}</code></pre>`;
      continue;
    }
    const title = heading(line);
    if (title) {
      const level = title[1].length;
      html += `<h${level}>${inline(title[2].replace(/[ \t]+#+[ \t]*$/, ''))}</h${level}>`;
      i++; continue;
    }
    if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1]) && !rule(line) && !list(line)) {
      const level = lines[i + 1].trim()[0] === '=' ? 1 : 2;
      html += `<h${level}>${inline(line.trim())}</h${level}>`;
      i += 2; continue;
    }
    if (rule(line)) { html += '<hr>'; i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      html += `<blockquote>${blocks(quoted, depth + 1)}</blockquote>`;
      continue;
    }
    const firstItem = list(line);
    if (firstItem) {
      const tag = firstItem.ordered ? 'ol' : 'ul';
      html += `<${tag}${firstItem.ordered && firstItem.number !== 1 ? ` start="${firstItem.number}"` : ''}>`;
      while (i < lines.length) {
        const item = list(lines[i]);
        if (!item || item.indent !== firstItem.indent || item.ordered !== firstItem.ordered) break;
        const body = [item.text];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            const following = list(lines[i + 1] || '');
            if (following && following.indent === firstItem.indent && following.ordered === firstItem.ordered) { i++; break; }
            if (/^ +\S/.test(lines[i + 1] || '')) { body.push(''); i++; continue; }
            break;
          }
          const indentation = lines[i].match(/^ */)[0].length;
          if (indentation <= firstItem.indent) break;
          body.push(lines[i++].slice(Math.min(indentation, firstItem.indent + 2)));
        }
        let content = blocks(body, depth + 1);
        if (/^<p>(?:(?!<\/p>)[\s\S])*<\/p>$/.test(content)) content = content.slice(3, -4);
        html += `<li>${content}</li>`;
      }
      html += `</${tag}>`;
      continue;
    }
    if (tableStart(lines, i)) {
      const headers = cells(line);
      html += `<div class="markdown-table"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = cells(lines[i++]);
        html += `<tr>${headers.map((_, column) => `<td>${inline(row[column] || '')}</td>`).join('')}</tr>`;
      }
      html += '</tbody></table></div>';
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i]) && !tableStart(lines, i)) paragraph.push(lines[i++]);
    html += `<p>${inline(paragraph.join('\n')).replace(/ {2,}\n/g, '<br>\n')}</p>`;
  }
  return html;
}

// Only tags constructed above enter the DOM; model HTML and all attribute values are escaped.
export function markdownToHtml(text) {
  return blocks(String(text).replace(/\r\n?/g, '\n').split('\n'));
}
