"""Read the paragraphs of a Word attachment from stdin, including table cells."""
import io
import resource
import sys
import zipfile
from xml.etree import ElementTree

resource.setrlimit(resource.RLIMIT_AS, (192 * 1024**2,) * 2)
resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
word = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as document:
    main = document.getinfo("word/document.xml")
    if main.file_size > 8 * 1024**2:
        raise ValueError("document too large")
    root = ElementTree.fromstring(document.read(main))
    for paragraph in root.iter(word + "p"):
        parts = []
        for node in paragraph.iter():
            if node.tag == word + "t":
                parts.append(node.text or "")
            elif node.tag == word + "tab":
                parts.append("\t")
            elif node.tag in (word + "br", word + "cr"):
                parts.append("\n")
        if parts:
            print("".join(parts))
