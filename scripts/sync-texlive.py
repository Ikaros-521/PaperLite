"""Add TL2022 runtime package closures to the static SwiftLaTeX mirror.

Python standard library only. Existing files (especially the bootstrapped LaTeX
kernel/format) are preserved. Downloads are cached outside the checkout.
"""
import concurrent.futures
import hashlib
import io
import json
import lzma
from pathlib import Path, PurePosixPath
import tarfile
import tempfile
import urllib.request

BASE = 'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2022/tlnet-final/'
ROOT = Path(__file__).resolve().parents[1] / 'public/xelatex'
CACHE = Path(tempfile.gettempdir()) / 'paperlite-tl2022'
PACKAGES = '''amsmath amsfonts amscls booktabs graphics tools pgf xcolor
hyperref geometry float caption enumitem listings fancyhdr ulem setspace
titlesec titling multirow makecell mathtools adjustbox fancyvrb fvextra
csquotes natbib bookmark cleveref microtype wrapfig parskip footmisc soul
newunicodechar environ standalone preview pgfplots colortbl threeparttable
xurl infwarerr siunitx physics cancel jknapltx rsfs stmaryrd wasysym wasy wasy-type1
upquote xunicode xltxtra tipa kvoptions etex-pkg everysel everyshi filehook
hopatch ifoddpage lineno multido newfloat bigfoot ragged2e realscripts svn-prov
translations translator varwidth zref algorithms ntheorem unicode-math lm-math latex-fonts cm
abstract hologo appendix biblatex bibtex tex-gyre babel babel-english hyphen-base svg pdfpages pdflscape koma-script transparent'''.split()
# These bundles support other engines too. Import their XeTeX runtime files,
# without pulling platform binaries or the entire pTeX/LuaTeX font ecosystem.
BUNDLES = ['latex', 'ctex', 'xecjk', 'fontspec', 'l3kernel', 'l3packages', 'lm']
SKIP = {'luatex', 'pdftex', 'xetex', 'tex', 'texlive.infra', 'latex-bin'}
ELEGANT_REV = '041a986646c74ed71f920d62532e6924cdb5c0ff'  # v0.10, matching the documentation fixture
ELEGANT_BASE = 'https://raw.githubusercontent.com/ElegantLaTeX/ElegantPaper/' + ELEGANT_REV + '/'


def download(relative):
    target = CACHE / relative.replace('/', '_')
    if not target.exists():
        with urllib.request.urlopen(BASE + relative, timeout=90) as response:
            data = response.read()
        target.write_bytes(data)
    return target.read_bytes()


def destinations(filename):
    filename = filename.removeprefix('texmf-dist/')
    p = PurePosixPath(filename)
    if filename.startswith('bibtex/bst/'):
        return [('7', p.name)]
    if filename.startswith('bibtex/bib/'):
        return [('6', p.name)]
    if filename.startswith('tex/'):
        return [('26', p.name)]
    formats = {'tfm': '3', 'afm': '4', 'type1': '32', 'vf': '33',
               'truetype': '36', 'opentype': '47', 'enc': '44',
               'map': '11', 'cmap': '45', 'sfd': '46', 'misc': '41'}
    parts = p.parts
    if len(parts) > 2 and parts[0] == 'fonts' and parts[1] in formats:
        fmt = formats[parts[1]]
        names = [p.name]
        # SwiftLaTeX requests TFM and some font names without their extension.
        if parts[1] in ('tfm', 'vf', 'opentype', 'truetype'):
            names.append(p.stem)
        return [(fmt, name) for name in names]
    return []


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    database = lzma.decompress(download('tlpkg/texlive.tlpdb.xz')).decode('utf-8')
    entries = {}
    for block in database.split('\n\n'):
        if block.startswith('name '):
            lines = block.splitlines()
            entries[lines[0][5:]] = lines
    selected = set(BUNDLES)

    def include(name):
        if name in selected or name in SKIP or '.ARCH' in name:
            return
        if name not in entries:
            raise ValueError('Unknown TeX Live package: ' + name)
        selected.add(name)
        for line in entries[name]:
            if line.startswith('depend '):
                include(line[7:])

    for name in PACKAGES:
        include(name)
    print('Resolving', len(selected), 'packages', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        archives = dict(zip(sorted(selected), pool.map(
            lambda name: download('archive/' + name + '.tar.xz'), sorted(selected))))
    provenance = []
    added = 0
    for name in sorted(selected):
        lines = entries[name]
        archive = archives[name]
        count = 0
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r|xz') as tar:
            for member in tar:
                if not member.isfile():
                    continue
                targets = destinations(member.name)
                data = tar.extractfile(member).read() if targets else None
                for fmt, filename in targets:
                    target = ROOT / 'repo/xetex' / fmt / filename
                    if target.exists():
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    count += 1
        added += count
        print(name + ': ' + str(count) + ' added', flush=True)
        provenance.append({
            'name': name,
            'revision': next(line[9:] for line in lines if line.startswith('revision ')),
            'license': next((line[18:] for line in lines if line.startswith('catalogue-license ')), 'see package headers'),
            'archive': BASE + 'archive/' + name + '.tar.xz',
            'sha256': hashlib.sha256(archive).hexdigest(),
        })
    (ROOT / 'packages.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8', newline='\n')
    # Equivalent to updmap for the selected packages. The original tiny map
    # omitted bold math and many symbols even when their font files existed.
    font_maps = []
    for name in sorted(selected):
        for line in entries[name]:
            parts = line.split()
            if len(parts) == 3 and parts[:2] in (['execute', 'addMap'], ['execute', 'addMixedMap']):
                font_maps.append(parts[2])
    combined = ['% Generated by scripts/sync-texlive.py from TL2022 updmap declarations.']
    for filename in sorted(set(font_maps)):
        source = ROOT / 'repo/xetex/11' / filename
        if not source.exists():
            raise ValueError('Missing declared font map: ' + filename)
        combined.extend(['% ' + filename, source.read_text(encoding='utf-8').rstrip()])
    (ROOT / 'repo/xetex/11/pdftex.map').write_text(
        '\n'.join(line.rstrip() for line in '\n'.join(combined).splitlines()) + '\n',
        encoding='utf-8', newline='\n')
    # ElegantPaper is not present in the TL2022 database. Vendor the original
    # upstream class and license at an immutable revision, with its own record.
    external = []
    for name, destination in [('elegantpaper.cls', ROOT / 'repo/xetex/26/elegantpaper.cls'),
                              ('License', ROOT / 'licenses/ElegantPaper.txt')]:
        cached = CACHE / ('elegantpaper-' + ELEGANT_REV + '-' + name)
        if not cached.exists():
            with urllib.request.urlopen(ELEGANT_BASE + name, timeout=90) as response:
                cached.write_bytes(response.read())
        data = cached.read_bytes()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        external.append({'url': ELEGANT_BASE + name,
                         'file': destination.relative_to(ROOT).as_posix(),
                         'sha256': hashlib.sha256(data).hexdigest(), 'license': 'LPPL-1.3c'})
    (ROOT / 'external-packages.json').write_text(
        json.dumps(external, indent=2) + '\n', encoding='utf-8', newline='\n')
    print('Added', added, 'runtime files; preserved existing kernel and format.')


if __name__ == '__main__':
    main()
