"""Labeled review illustrations from actual payloads, not live Discord screenshots."""
import json
import pathlib
import re
from PIL import Image, ImageDraw, ImageFont
OUT = pathlib.Path(__file__).resolve().parent.parent / 'docs/event-dm-recipients'
DATA = json.loads((OUT / 'payloads.json').read_text())
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans'


def font(size=16, bold=False):
    return ImageFont.truetype(FONT + ('-Bold' if bold else '') + '.ttf', size)


def wrap(draw, text, face, width):
    lines = []
    for para in text.split('\n'):
        line = ''
        for word in para.split(' '):
            if line and draw.textlength(line + ' ' + word, font=face) > width:
                lines.append(line)
                line = ''
            line = (line + ' ' + word).strip()
        lines.append(line)
    return lines


for name, payload in DATA.items():
    for size, width in [('mobile', 420), ('desktop', 920)]:
        canvas = Image.new('RGB', (width, 4000), '#202127')
        draw = ImageDraw.Draw(canvas)
        draw.text((18, 16), 'OFFLINE UI REVIEW • FIXTURES', font=font(14, True), fill='#ff9a51')
        draw.text((18, 40), 'Actual payloads; not a Discord screenshot', font=font(13), fill='#bfc0c4')
        y = 80
        content = payload['content'].replace('🧡🖤', '♥ ♥')
        content = content.replace('<@fixture-member>', '@Mary (fixture)').replace('<#fixture-room>', '#listening-party-room')
        content = re.sub(r'<@900000>', '@Alice', content)
        content = re.sub(r'<@900012>', '@Mary', content)
        content = re.sub(r'<@900017>', '@Susan', content)
        content = re.sub(r'<t:\d+:F>', 'Sunday, June 23, 2030 at 7:00 PM', content)
        for line in content.split('\n'):
            face = font(17, True) if '**' in line else font(16)
            for row in wrap(draw, line.replace('**', ''), face, width - 40):
                draw.text((20, y), row, font=face, fill='#f3f3f6')
                y += 24
        y += 20
        for row in payload['components']:
            x = 16
            for c in row['components']:
                if c['type'] == 2:
                    label = c['label'] + (' ↗' if c['style'] == 5 else '')
                    face = font(14)
                    w = int(draw.textlength(label, font=face)) + 26
                    if x + w > width - 16 and x != 16:
                        x, y = 16, y + 50
                    color = {1: '#5865f2', 3: '#248346', 4: '#a83c42'}.get(c['style'], '#4b4e58')
                    if c.get('disabled'):
                        color = '#303238'
                    draw.rounded_rectangle((x, y, x + w, y + 40), 5, fill=color)
                    draw.text((x + 13, y + 10), label, font=face, fill='white')
                    x += w + 8
                else:
                    draw.rounded_rectangle((16, y, width - 16, y + 42), 5, fill='#111217')
                    for n, text in enumerate(wrap(draw, c.get('placeholder', 'Choose') + ' ▾', font(13), width - 48)):
                        draw.text((26, y + 11 + n * 20), text, font=font(13), fill='#e4e4e9')
            y += 54
            for c in row['components']:
                if c['type'] == 3:
                    draw.text((24, y), 'Expanded list (first 6 options shown)', font=font(12), fill='#bfc0c4')
                    y += 26
                    for option in c.get('options', [])[:6]:
                        checked = option.get('default', False)
                        draw.rectangle((24, y + 3, 40, y + 19), fill='#5865f2' if checked else '#202127', outline='#bfc0c4')
                        if checked:
                            draw.text((25, y), '✓', font=font(16), fill='white')
                        draw.text((50, y), option['label'], font=font(15), fill='#f3f3f6')
                        y += 30
                    y += 10
        canvas.crop((0, 0, width, y + 12)).save(OUT / f'{name}-{size}.png')
print('Rendered recipient manager review illustrations from actual component data.')
