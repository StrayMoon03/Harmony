"""Review illustrations from actual manager payloads; not live Discord screenshots."""
import json
import pathlib
import re
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent.parent / 'docs/countdown-manager-simplified'
DATA = json.loads((OUT / 'manager-payloads.json').read_text())
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans'


def font(size=17, bold=False):
    return ImageFont.truetype(FONT + ('-Bold' if bold else '') + '.ttf', size)


def lines(draw, text, face, width):
    result = []
    for paragraph in text.split('\n'):
        line = ''
        for word in paragraph.split(' '):
            if line and draw.textlength(line + ' ' + word, font=face) > width:
                result.append(line)
                line = ''
            for char in word:
                if draw.textlength(line + char, font=face) > width:
                    result.append(line)
                    line = ''
                line += char
            line += ' '
        result.append(line.strip())
    return result


for name, payload in DATA.items():
    for size, width in [('desktop', 920), ('mobile', 420)]:
        canvas = Image.new('RGB', (width, 7000), '#202127')
        draw = ImageDraw.Draw(canvas)
        face = font(18 if size == 'desktop' else 15)
        title_face = font(24 if size == 'desktop' else 20, True)
        y = 18
        for text in ['PRIVATE UI REVIEW • FIXTURES', 'Actual component payloads', 'Illustration, not a Discord screenshot']:
            draw.text((18, y), text, font=font(14, True), fill='#ff9a51' if y == 18 else '#c9c9ce')
            y += 23
        y += 12
        if payload.get('content'):
            for line in lines(draw, payload['content'], face, width - 48):
                draw.text((24, y), line, font=face, fill='white')
                y += 24
        for embed in payload.get('embeds', []):
            text = re.sub(r'<#[^>]+>', '#chicago-concert', embed['description']).replace('**', '')
            text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1: \2', text)
            title_lines = lines(draw, embed['title'], title_face, width - 80)
            body_lines = lines(draw, text, face, width - 80)
            height = 38 + len(title_lines) * 30 + len(body_lines) * 25
            draw.rounded_rectangle((16, y, width - 16, y + height), 7, fill='#2b2d33')
            draw.rectangle((16, y + 7, 20, y + height - 7), fill='#ff862f')
            ty = y + 16
            for line in title_lines:
                draw.text((36, ty), line, font=title_face, fill='#f5f5f7')
                ty += 30
            ty += 10
            for line in body_lines:
                draw.text((36, ty), line, font=face, fill='#e4e4e9')
                ty += 25
            y += height + 16
        for file in payload.get('files', []):
            im = Image.open(OUT / file['attachment']).convert('RGB')
            im = im.resize((width - 32, round(im.height * (width - 32) / im.width)))
            canvas.paste(im, (16, y))
            y += im.height + 16
        for row in payload.get('components', []):
            x = 16
            for component in row['components']:
                if component['type'] == 2:
                    label = component['label']
                    button_font = font(16 if size == 'desktop' else 14)
                    w = int(draw.textlength(label, font=button_font)) + 26
                    if x + w > width - 16 and x != 16:
                        x, y = 16, y + 50
                    color = {1: '#5865f2', 3: '#248346'}.get(component['style'], '#4b4e58')
                    if component.get('disabled'):
                        color = '#303238'
                    draw.rounded_rectangle((x, y, x + w, y + 40), 5, fill=color)
                    draw.text((x + 13, y + 10), label, font=button_font, fill='#a0a1aa' if component.get('disabled') else 'white')
                    x += w + 8
                else:
                    draw.rounded_rectangle((16, y, width - 16, y + 42), 5, fill='#111217')
                    draw.text((28, y + 11), component.get('placeholder', 'Choose') + ' ▾', font=font(14), fill='#e4e4e9')
                    if name in ('concert-picker', 'configured', 'discovery-results'):
                        for option in component.get('options', [])[:3]:
                            y += 46
                            for line in lines(draw, option['label'], font(14, True), width - 64):
                                draw.text((30, y), line, font=font(14, True), fill='white')
                                y += 20
                            for line in lines(draw, option.get('description', ''), font(13), width - 64):
                                draw.text((30, y), line, font=font(13), fill='#bfc0c4')
                                y += 18
                        if len(component.get('options', [])) > 3:
                            y += 28
                            draw.text((30, y), '… More options in this dropdown', font=font(13), fill='#bfc0c4')
            y += 52
        canvas.crop((0, 0, width, y + 12)).save(OUT / f'{name}-{size}.png')
print('Rendered desktop/mobile review illustrations from actual manager payloads.')
