"""Оборачивает русские тексты интерфейса в t('…') для перевода.

Запуск: python3 tools/i18n/wrap.py docs/js/app.js [ещё файлы]
- одинарные/двойные строки с кириллицей → t('…');
- строки с HTML и шаблонные строки: кириллица в тексте между тегами и в значениях атрибутов → ${t('…')};
- не трогает комментарии, регулярные выражения, строки после ===/!==/case и строки с пометкой /*no-t*/ перед ними;
- уже обёрнутое t('…') не трогает повторно.
"""
import re
import sys

CYR = re.compile(r'[А-Яа-яЁё]')


def q(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def wrap_html_text(parts, in_tag_start=False):
    """parts: список ('text', str) | ('expr', str). Возвращает новый шаблон без обрамляющих кавычек."""
    out = []
    in_tag = in_tag_start
    quote = None
    for kind, val in parts:
        if kind == 'expr':
            out.append('${' + process_code(val) + '}')
            continue
        i = 0
        buf = ''
        res = ''

        def flush_text(b):
            if not CYR.search(b):
                return b
            m = re.match(r'^(\s*)(.*?)(\s*)$', b, re.S)
            lead, core, tail = m.groups()
            return f"{lead}${{t({q(core)})}}{tail}"

        while i < len(val):
            c = val[i]
            if not in_tag:
                if c == '<':
                    res += flush_text(buf)
                    buf = ''
                    in_tag = True
                    res += c
                else:
                    buf += c
            else:
                if quote:
                    if c == quote:
                        res += flush_text(buf) + c
                        buf = ''
                        quote = None
                    else:
                        buf += c
                else:
                    if c in '"\'':
                        quote = c
                        res += c
                    elif c == '>':
                        in_tag = False
                        res += c
                    else:
                        res += c
            i += 1
        res += flush_text(buf) if (not in_tag or quote) else buf
        out.append(res)
    return ''.join(out)


def read_template(src, i):
    """src[i] == '`'. Возвращает (parts, end_index_after_backtick)."""
    i += 1
    parts = []
    text = ''
    while i < len(src):
        c = src[i]
        if c == '\\':
            text += src[i:i + 2]
            i += 2
            continue
        if c == '`':
            parts.append(('text', text))
            return parts, i + 1
        if c == '$' and src[i + 1:i + 2] == '{':
            parts.append(('text', text))
            text = ''
            depth = 1
            j = i + 2
            expr_start = j
            while j < len(src) and depth:
                ch = src[j]
                if ch in '\'"':
                    j = skip_string(src, j)
                    continue
                if ch == '`':
                    _, j = read_template(src, j)
                    continue
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            parts.append(('expr', src[expr_start:j]))
            i = j + 1
            continue
        text += c
        i += 1
    raise ValueError('незакрытый шаблон')


def skip_string(src, i):
    qch = src[i]
    i += 1
    while i < len(src):
        if src[i] == '\\':
            i += 2
            continue
        if src[i] == qch:
            return i + 1
        i += 1
    return i


REGEX_PREV = set('(,=:[!&|?{};+-*%<>~^')


def process_code(src):
    out = []
    i = 0
    last_sig = ''
    while i < len(src):
        c = src[i]
        two = src[i:i + 2]
        if two == '//':
            j = src.find('\n', i)
            j = len(src) if j < 0 else j
            out.append(src[i:j])
            i = j
            continue
        if two == '/*':
            j = src.find('*/', i + 2) + 2
            out.append(src[i:j])
            i = j
            continue
        if c == '/' and (last_sig in REGEX_PREV or last_sig == '' or re.search(r'(return|typeof|case)\s*$', ''.join(out[-3:]))):
            # регулярное выражение — копируем как есть
            j = i + 1
            in_cls = False
            while j < len(src):
                ch = src[j]
                if ch == '\\':
                    j += 2
                    continue
                if ch == '[':
                    in_cls = True
                elif ch == ']':
                    in_cls = False
                elif ch == '/' and not in_cls:
                    break
                j += 1
            j += 1
            while j < len(src) and src[j].isalpha():
                j += 1
            out.append(src[i:j])
            i = j
            last_sig = 'x'
            continue
        if c in '\'"':
            j = skip_string(src, i)
            lit = src[i:j]
            body = lit[1:-1]
            prev = ''.join(out)[-12:]
            skip = re.search(r'(===|!==|==|!=|case)\s*$', prev) or prev.rstrip().endswith('/*no-t*/') or re.search(r"\bt\(\s*$", prev)
            if CYR.search(body) and not skip:
                if '<' in body and '>' in body:
                    raw = body.encode().decode('unicode_escape') if '\\' in body and qch_simple(lit) else body
                    out.append('`' + wrap_html_text([('text', raw.replace('`', '\\`'))]) + '`')
                else:
                    out.append('t(' + lit + ')')
            else:
                out.append(lit)
            i = j
            last_sig = 'x'
            continue
        if c == '`':
            parts, j = read_template(src, i)
            prev = ''.join(out)[-12:]
            if any(k == 'text' and CYR.search(v) for k, v in parts) or any(k == 'expr' for k, v in parts):
                if re.search(r"\bt\(\s*$", prev):
                    out.append(src[i:j])
                else:
                    out.append('`' + wrap_html_text(parts) + '`')
            else:
                out.append(src[i:j])
            i = j
            last_sig = 'x'
            continue
        out.append(c)
        if not c.isspace():
            last_sig = c if not (c.isalnum() or c in '_$') else 'x'
            if c in ')]}':
                last_sig = 'x'
        i += 1
    return ''.join(out)


def qch_simple(lit):
    return False


def main():
    for path in sys.argv[1:]:
        src = open(path, encoding='utf-8').read()
        new = process_code(src)
        open(path, 'w', encoding='utf-8').write(new)
        print(path, 'обёрнуто:', new.count("t('") - src.count("t('"))


if __name__ == '__main__':
    main()
