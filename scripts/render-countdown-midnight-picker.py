"""Offline review illustration from the actual Add Countdown component payload."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
out = Path(__file__).resolve().parent.parent / 'docs/countdown-midnight-fix'
payload = json.loads((out / 'picker-payload.json').read_text())
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans'
def font(size=14, bold=False):
    return ImageFont.truetype(font_path + ('-Bold' if bold else '') + '.ttf', size)
def wrap(draw, value, width, face):
    line = ''
    for word in value.split():
        if line and draw.textlength(line + ' ' + word, font=face) > width:
            yield line
            line = ''
        line = (line + ' ' + word).strip()
    if line:
        yield line
for width, size in [(480, 'mobile'), (1000, 'desktop')]:
    image = Image.new('RGB', (width, 3000), '#202127')
    draw = ImageDraw.Draw(image)
    y = 20
    draw.text((18, y), 'OFFLINE UI REVIEW • ACTUAL PAYLOAD', font=font(13, True), fill='#ff9a51')
    y += 28
    draw.text((18, y), 'Test data; expanded lists for review', font=font(13), fill='#bfc0c4')
    y += 34
    for e in payload['embeds']:
        for line in wrap(draw, e['title'], width-36, font(18, True)):
            draw.text((18, y), line, font=font(18, True), fill='white'); y += 26
        for line in wrap(draw, e['description'], width-36, font(14)):
            draw.text((18, y), line, font=font(), fill='#dddddf'); y += 22
    y += 18
    for row in payload['components']:
        for c in row['components']:
            if c.get('options'):
                draw.rounded_rectangle((12, y, width-12, y+36), 4, fill='#101116')
                draw.text((22, y+10), c['placeholder']+' ▾', font=font(), fill='white'); y += 44
                for opt in c['options']:
                    highlighted = opt['value'] in ['toronto', 'vancouver']
                    for line in wrap(draw, opt['label'], width-48, font(13, highlighted)):
                        draw.text((26, y), line, font=font(13, highlighted), fill='#ff9a51' if highlighted else '#d8d8dc'); y += 21
                y += 14
    image.crop((0, 0, width, y+12)).save(out / f'picker-{size}.png')
print('Rendered full 34-location picker, including both native menus.')
