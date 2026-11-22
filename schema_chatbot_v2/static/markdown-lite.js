/*
 * markdown-lite.js: sanitising Markdown renderer and source helpers for the Query Bot.
 *
 * All HTML in the input is escaped first, so raw tags such as <script> or <img onerror>
 * are shown as text. Only these Markdown constructs are then turned into elements:
 * headings, paragraphs, bold, italic, inline code, code fences, bullet and numbered lists,
 * pipe tables, and links. Links are kept only for http(s) URLs and relative paths.
 * javascript:, data: and other scheme links are dropped and only their text is shown.
 *
 * Browser: loaded with a plain script tag, exposes window.QueryBotRender.
 * Node: module.exports (used by the pytest renderer tests).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.QueryBotRender = api;
    }
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    const SNIPPET_MAX = 160;
    const BULLET_RE = /^([-*+]|\u2022)\s+/;
    const ORDERED_RE = /^\d+[.)]\s+/;
    const HEADING_RE = /^(#{1,6})\s+(.*)$/;
    const FENCE_RE = /^```/;

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function unescapeHtml(value) {
        return String(value)
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
    }

    // Allows http(s) URLs and relative paths. Anything with another scheme returns null.
    function safeHref(raw) {
        const url = String(raw === null || raw === undefined ? '' : raw).trim();
        if (!url) return null;
        if (/^https?:\/\/\S+$/i.test(url)) return url;
        if (url.startsWith('//')) return null;
        if (/\s/.test(url)) return null;
        if (/^[^:/?#]*([/?#]|$)/.test(url)) return url;
        return null;
    }

    function renderEmphasis(text) {
        return text
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    }

    function renderLinks(text) {
        // `text` is already escaped. Unescape the URL to check it, then escape it again for the attribute.
        return text.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, function (match, label, rawUrl) {
            const href = safeHref(unescapeHtml(rawUrl));
            if (!href) return label;
            return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
        });
    }

    function renderInline(escaped) {
        // Code spans first, so their content is not changed by the other rules.
        return escaped.split(/`([^`\n]+)`/).map(function (part, index) {
            if (index % 2 === 1) return '<code>' + part + '</code>';
            return renderLinks(renderEmphasis(part));
        }).join('');
    }

    function splitRow(line) {
        let row = line.trim();
        if (row.startsWith('|')) row = row.slice(1);
        if (row.endsWith('|')) row = row.slice(0, -1);
        return row.split('|').map(function (cell) { return cell.trim(); });
    }

    function isTableRow(line) {
        return line.indexOf('|') !== -1 && splitRow(line).length >= 2;
    }

    function isTableSeparator(line) {
        return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());
    }

    function startsBlock(line) {
        return FENCE_RE.test(line) || HEADING_RE.test(line) || BULLET_RE.test(line) || ORDERED_RE.test(line);
    }

    function renderTable(header, rows) {
        const head = header.map(function (cell) { return '<th>' + renderInline(escapeHtml(cell)) + '</th>'; }).join('');
        const body = rows.map(function (row) {
            return '<tr>' + row.map(function (cell) { return '<td>' + renderInline(escapeHtml(cell)) + '</td>'; }).join('') + '</tr>';
        }).join('');
        return '<div class="qb-table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }

    function renderMarkdown(source) {
        const text = String(source === null || source === undefined ? '' : source).replace(/\r\n?/g, '\n');
        const lines = text.split('\n');
        const html = [];
        let i = 0;

        while (i < lines.length) {
            const trimmed = lines[i].trim();
            if (!trimmed) {
                i += 1;
                continue;
            }

            if (FENCE_RE.test(trimmed)) {
                const code = [];
                i += 1;
                while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
                    code.push(lines[i]);
                    i += 1;
                }
                i += 1; // closing fence, or end of input
                html.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
                continue;
            }

            const heading = HEADING_RE.exec(trimmed);
            if (heading) {
                const level = Math.min(heading[1].length + 2, 5);
                html.push('<h' + level + '>' + renderInline(escapeHtml(heading[2])) + '</h' + level + '>');
                i += 1;
                continue;
            }

            if (isTableRow(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
                const header = splitRow(trimmed);
                const rows = [];
                i += 2;
                while (i < lines.length && lines[i].trim() && isTableRow(lines[i].trim())) {
                    rows.push(splitRow(lines[i].trim()));
                    i += 1;
                }
                html.push(renderTable(header, rows));
                continue;
            }

            if (BULLET_RE.test(trimmed)) {
                const items = [];
                while (i < lines.length && BULLET_RE.test(lines[i].trim())) {
                    items.push(lines[i].trim().replace(BULLET_RE, ''));
                    i += 1;
                }
                html.push('<ul>' + items.map(function (item) { return '<li>' + renderInline(escapeHtml(item)) + '</li>'; }).join('') + '</ul>');
                continue;
            }

            if (ORDERED_RE.test(trimmed)) {
                const items = [];
                while (i < lines.length && ORDERED_RE.test(lines[i].trim())) {
                    items.push(lines[i].trim().replace(ORDERED_RE, ''));
                    i += 1;
                }
                html.push('<ol>' + items.map(function (item) { return '<li>' + renderInline(escapeHtml(item)) + '</li>'; }).join('') + '</ol>');
                continue;
            }

            const para = [];
            while (i < lines.length && lines[i].trim() && !startsBlock(lines[i].trim())
                   && !(isTableRow(lines[i].trim()) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
                para.push(lines[i].trim());
                i += 1;
            }
            if (para.length === 0) {
                // Safety net for an unmatched line: show it as plain escaped text.
                para.push(trimmed);
                i += 1;
            }
            html.push('<p>' + para.map(function (line) { return renderInline(escapeHtml(line)); }).join('<br>') + '</p>');
        }
        return html.join('');
    }

    function sourceLabel(source) {
        return source && source.page ? 'Page ' + source.page : 'Document';
    }

    // One source per page, sorted by page. The first snippet for a page is kept.
    function dedupeSources(sources) {
        const byPage = new Map();
        (sources || []).forEach(function (src) {
            if (!src || src.page === null || src.page === undefined || src.page === '') return;
            const page = Number(src.page);
            if (!byPage.has(page)) byPage.set(page, src);
        });
        return Array.from(byPage.keys()).sort(function (a, b) { return a - b; }).map(function (page) { return byPage.get(page); });
    }

    function snippet(text) {
        const clean = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
        return clean.length > SNIPPET_MAX ? clean.slice(0, SNIPPET_MAX - 1) + '\u2026' : clean;
    }

    return {
        escapeHtml: escapeHtml,
        renderMarkdown: renderMarkdown,
        safeHref: safeHref,
        sourceLabel: sourceLabel,
        dedupeSources: dedupeSources,
        snippet: snippet,
    };
});
