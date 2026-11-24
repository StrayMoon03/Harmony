"""Render clearly identified UI previews from actual Discord component payloads.
These are review illustrations, not screenshots from a live Discord client.
"""
import json
import pathlib
import re
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent.parent / 'docs/countdown-previews'
DATA = json.loads((OUT / 'manager-payloads.json').read_text())
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans'


def font(size=19, bold=False):
    return ImageFont.truetype(FONT + ('-Bold' if bold else '') + '.ttf', size)


def wrap(draw, text, face, width):
    lines = []
    for paragraph in text.split('\n'):
        current = ''
        for word in paragraph.split(' '):
            if draw.textlength(current + ' ' + word, font=face) > width and current:
                lines.append(current)
                current = ''
            current = (current + ' ' + word).strip()
        lines.append(current)
    return lines


for name in ('home', 'details', 'setup', 'events'):
    payload = DATA[name]
    canvas = Image.new('RGB', (920, 1500), '#202127')
    draw = ImageDraw.Draw(canvas)
    draw.text((26, 22), 'UI PREVIEW • ACTUAL COMPONENT DATA • FIXTURES', font=font(17, True), fill='#ff9a51')
    draw.text((26, 50), 'Review illustration; not a live Discord screenshot', font=font(16), fill='#bfc0c4')
    y = 92
    for embed in payload['embeds']:
        title = embed['title']
        text = re.sub(r'<#[^>]+>', '#chicago-concert-room', embed['description']).replace('**', '')
        lines = wrap(draw, text, font(), 810)
        height = 84 + len(lines) * 28
        draw.rounded_rectangle((24, y, 896, y + height), 8, fill='#2b2d33')
        draw.rectangle((24, y+8, 28, y+height-8), fill='#ff862f')
        draw.text((48, y+18), title, font=font(25, True), fill='#f5f5f7')
        for n, line in enumerate(lines):
            draw.text((48, y+67+n*28), line, font=font(), fill='#e4e4e9')
        y += height + 16
    for row in payload['components']:
        x = 24
        for component in row['components']:
            if component['type'] == 2:
                label = component['label']
                width = int(draw.textlength(label, font=font(16))) + 34
                if x + width > 896:
                    x, y = 24, y + 58
                color = {1:'#5865f2', 3:'#248346'}.get(component['style'], '#4b4e58')
                if component.get('disabled'):
                    color = '#303238'
                draw.rounded_rectangle((x,y,x+width,y+44), 5, fill=color)
                draw.text((x+17,y+11), label, font=font(16), fill='#b3b4ba' if component.get('disabled') else 'white')
                x += width + 8
            else:
                draw.rounded_rectangle((24,y,896,y+48), 5, fill='#111217')
                draw.text((40,y+13), component.get('placeholder','Select') + ' ▾', font=font(17), fill='#e4e4e9')
                if name == 'events':
                    for option in component.get('options', []):
                        y += 40
                        draw.text((42,y+14), '[selected] ' + option['label'], font=font(16), fill='#f0f0f3')
        y += 60
    canvas.crop((0,0,920,y+12)).save(OUT / ('manager-'+name+'.png'))
print('Created four labeled manager UI previews from actual component payloads.')
