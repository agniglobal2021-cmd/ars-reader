"""Builds the test books in test/books/: EPUB (with a chapter full of script traps), FB2, FB2 in zip, CBZ.
Only the standard library is used. The text is generated, so there is nothing to license."""

import base64
import os
import random
import struct
import sys
import zipfile
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "books")

WORDS = ("город свет дорога колокол тишина ветер окно память книга слово река камень утро вечер сад башня "
         "лестница небо огонь голос странник монастырь рукопись свеча икона двор площадь мост туман зима "
         "колодец дерево птица вода хлеб соль дом порог ключ замок тень зеркало").split()
ADJ = ("старый тихий светлый дальний каменный ночной золотой медленный забытый высокий тёплый "
       "одновременный достопримечательный преобразовательный").split()
VERB = "видел помнил ждал искал слышал строил открывал переписывал хранил читал".split()


def sentence(rnd):
    words = [rnd.choice(ADJ), rnd.choice(WORDS), rnd.choice(VERB), rnd.choice(ADJ), rnd.choice(WORDS)]
    for _ in range(rnd.randint(2, 9)):
        words.append(rnd.choice(WORDS + ADJ))
    s = " ".join(words)
    return s[0].upper() + s[1:] + rnd.choice([".", ".", ".", "!", "…", "?"])


def paragraph(rnd, n=None):
    return " ".join(sentence(rnd) for _ in range(n or rnd.randint(3, 7)))


def png(w, h, colour):
    rows = bytearray()
    r0, g0, b0 = colour
    for y in range(h):
        rows.append(0)
        for x in range(w):
            k = ((x // 16) + (y // 16)) % 2
            rows += bytes((max(0, r0 - 40 * k), max(0, g0 - 40 * k), max(0, b0 - 40 * k)))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def xhtml(title, body, head_extra=""):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ru" xml:lang="ru">
<head><meta charset="utf-8"/><title>{title}</title><link rel="stylesheet" type="text/css" href="style.css"/>{head_extra}</head>
<body>
{body}
</body>
</html>
"""


def make_epub(path):
    rnd = random.Random(7)
    chapters = []
    for i in range(1, 6):
        paras = "\n".join(f"<p>{paragraph(rnd)}</p>" for _ in range(28))
        sub = ""
        if i == 2:
            sub = ('<h2 id="part-a">Часть А</h2>\n' + "\n".join(f"<p>{paragraph(rnd)}</p>" for _ in range(8))
                   + '\n<h2 id="part-b">Часть Б</h2>\n' + "\n".join(f"<p>{paragraph(rnd)}</p>" for _ in range(8)))
        chapters.append(xhtml(f"Глава {i}", f'<h1 id="top">Глава {i}. {rnd.choice(ADJ).capitalize()} {rnd.choice(WORDS)}</h1>\n{paras}\n{sub}'))

    evil_head = '<meta http-equiv="refresh" content="0;url=javascript:parent.__pwned_refresh=1"/><script>parent.__pwned_head=1</script>'
    evil_body = """<h1>Глава с ловушками</h1>
<p id="evil-text">Если ты видишь этот текст, а скрипты не сработали, защита работает.</p>
<script>parent.__pwned_inline = 1; window.top.__pwned_inline = 1</script>
<script src="evil.js"></script>
<img id="evil-img" src="missing.png" onerror="parent.__pwned_onerror = 1" alt="битая картинка"/>
<p><a id="jslink" href="javascript:parent.__pwned_link=1">ссылка-ловушка</a></p>
<p><a id="extlink" href="https://example.org/">внешняя ссылка</a></p>
<iframe src="data:text/html,&lt;script&gt;parent.parent.__pwned_iframe=1&lt;/script&gt;"></iframe>
<object data="data:text/html,&lt;script&gt;parent.parent.__pwned_object=1&lt;/script&gt;"></object>
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>parent.__pwned_svg=1</script>
<rect width="40" height="40" fill="teal" onload="parent.__pwned_svgload=1"/></svg>
<form action="javascript:parent.__pwned_form=1"><button id="formbtn" type="submit">отправить</button></form>
<p onclick="parent.__pwned_click=1" id="clickme">нажми меня</p>
<img src="https://example.org/tracker.png" id="remote" alt="удалённая картинка"/>"""
    evil = xhtml("Ловушки", evil_body, evil_head)

    nav = xhtml("Оглавление", """<nav epub:type="toc" id="toc"><h1>Оглавление</h1><ol>
<li><a href="cover.xhtml">Обложка</a></li>
<li><a href="ch1.xhtml">Глава 1</a></li>
<li><a href="ch2.xhtml">Глава 2</a><ol><li><a href="ch2.xhtml#part-a">Часть А</a></li><li><a href="ch2.xhtml#part-b">Часть Б</a></li></ol></li>
<li><a href="ch3.xhtml">Глава 3</a></li>
<li><a href="ch4.xhtml">Глава 4</a></li>
<li><a href="ch5.xhtml">Глава 5</a></li>
<li><a href="evil.xhtml">Глава с ловушками</a></li>
</ol></nav>""")
    cover = xhtml("Обложка", '<div style="text-align:center"><img src="cover.png" alt="Обложка" style="max-height:95vh"/></div>')
    css = "body { font-family: serif; margin: 0 } h1 { font-size: 1.6em; margin: 0 0 1em } p { margin: 0; text-indent: 1.5em }\n"
    opf = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="ru">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:isbn:978-5-17-090622-7</dc:identifier>
<dc:title>Светлый град: тестовая книга</dc:title>
<dc:creator id="a1">Иван Тестов</dc:creator>
<dc:creator id="a2">Мария Проверкина</dc:creator>
<dc:contributor id="t1">Пётр Переводчиков</dc:contributor>
<meta refines="#t1" property="role" scheme="marc:relators">trl</meta>
<dc:publisher>Издательство «Проверка»</dc:publisher>
<dc:date>2026-05-01</dc:date>
<dc:language>ru</dc:language>
<dc:description>&lt;p&gt;Книга для &lt;b&gt;проверки&lt;/b&gt; Читальни.&lt;/p&gt;&lt;p&gt;Второй абзац.&lt;/p&gt;</dc:description>
<meta property="dcterms:modified">2026-05-01T00:00:00Z</meta>
<meta name="cover" content="cover-img"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="evil-js" href="evil.js" media-type="text/javascript"/>
""" + "".join(f'<item id="ch{i}" href="ch{i}.xhtml" media-type="application/xhtml+xml"/>\n' for i in range(1, 6)) + """<item id="evil" href="evil.xhtml" media-type="application/xhtml+xml" properties="scripted svg"/>
</manifest>
<spine>
<itemref idref="cover"/>
""" + "".join(f'<itemref idref="ch{i}"/>\n' for i in range(1, 6)) + """<itemref idref="evil"/>
</spine>
</package>
"""
    container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/cover.xhtml", cover, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/cover.png", png(300, 450, (40, 70, 120)), compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/style.css", css, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/evil.js", "parent.__pwned_external = 1; window.top.__pwned_external = 1;", compress_type=zipfile.ZIP_DEFLATED)
        for i, ch in enumerate(chapters, 1):
            z.writestr(f"OEBPS/ch{i}.xhtml", ch, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/evil.xhtml", evil, compress_type=zipfile.ZIP_DEFLATED)


def make_fb2():
    rnd = random.Random(11)
    paras = lambda n: "\n".join(f"<p>{paragraph(rnd)}</p>" for _ in range(n))  # noqa: E731
    cover = base64.b64encode(png(200, 300, (120, 60, 40))).decode()
    return f"""<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>prose_contemporary</genre>
<author><first-name>Анна</first-name><last-name>Полевая</last-name></author>
<book-title>Записки на полях</book-title>
<annotation><p>Тестовая книга в FB2.</p></annotation>
<coverpage><image l:href="#cover.png"/></coverpage>
<lang>ru</lang>
</title-info>
<publish-info><publisher>Самиздат</publisher><year>2025</year><isbn>978-5-00-000000-2</isbn></publish-info>
</description>
<body>
<title><p>Записки на полях</p></title>
<section><title><p>Часть первая</p></title>
{paras(20)}
<p>Здесь сноска<a l:href="#n1" type="note">[1]</a>, а здесь <a l:href="javascript:parent.__pwned_fb2=1" id="fb2-evil">ссылка-ловушка</a>.</p>
{paras(10)}
</section>
<section><title><p>Часть вторая</p></title>
<section><title><p>Глава 2.1</p></title>
{paras(15)}
</section>
<section><title><p>Глава 2.2</p></title>
<poem><stanza><v>Над рекой туман и тишина,</v><v>и колокол звонит издалека.</v></stanza></poem>
{paras(15)}
</section>
</section>
</body>
<body name="notes">
<section id="n1"><title><p>1</p></title><p>Текст сноски.</p></section>
</body>
<binary id="cover.png" content-type="image/png">{cover}</binary>
</FictionBook>
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    make_epub(os.path.join(OUT, "Светлый град.epub"))
    fb2 = make_fb2()
    with open(os.path.join(OUT, "Записки на полях.fb2"), "w", encoding="utf-8") as fh:
        fh.write(fb2)
    with zipfile.ZipFile(os.path.join(OUT, "Записки в архиве.fb2.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Записки на полях.fb2", fb2)
    with zipfile.ZipFile(os.path.join(OUT, "Комикс.cbz"), "w", zipfile.ZIP_DEFLATED) as z:
        for i, colour in enumerate([(200, 80, 80), (80, 160, 90), (70, 90, 200)], 1):
            z.writestr(f"page{i:02}.png", png(600, 900, colour))
    for name in sorted(os.listdir(OUT)):
        print(f"{os.path.getsize(os.path.join(OUT, name)):>9}  {name}")


if __name__ == "__main__":
    sys.exit(main())
