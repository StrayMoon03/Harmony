"""Offline header illustrations from actual topic text; not Discord screenshots."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
out = Path(__file__).resolve().parent.parent / 'docs/concert-topic-countdown'
data = json.loads((out / 'previews.json').read_text())
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans'
def font(n=16, bold=False):
    return ImageFont.truetype(font_path + ('-Bold' if bold else '') + '.ttf', n)
def wrap(draw, text, width, face):
    for paragraph in text.split('\n'):
        line = ''
        for word in paragraph.split(' '):
            if line and draw.textlength(line + ' ' + word, font=face) > width:
                yield line
                line = ''
            line = (line + ' ' + word).strip()
        yield line
for case in data:
    for width, size in [(480, 'mobile'), (1000, 'desktop')]:
        image = Image.new('RGB', (width, 1200), '#313338'); draw = ImageDraw.Draw(image)
        draw.text((18, 16), 'OFFLINE TOPIC REVIEW • TEST DATA', font=font(13, True), fill='#ff9a51')
        draw.text((18, 40), 'Actual text; illustrated header, not a screenshot', font=font(12), fill='#b9bbbe')
        draw.line((0, 74, width, 74), fill='#202225', width=2)
        draw.text((18, 93), '# chicago-concert', font=font(20, True), fill='white')
        draw.text((18, 130), 'CHANNEL TOPIC', font=font(12, True), fill='#b9bbbe'); y = 160
        # Mono font uses a heart glyph; colors represent the actual orange/black emoji.
        text = case['topic'].replace('🧡', '♥').replace('🖤', '♥')
        hearts = 0
        for line in wrap(draw, text, width - 36, font(16)):
            x = 18
            for char in line:
                color = '#f2f3f5'
                if char == '♥':
                    color = '#ff862f' if hearts == 0 else '#090a0c'
                    hearts += 1
                draw.text((x, y), char, font=font(16), fill=color)
                x += draw.textlength(char, font=font(16))
            y += 26
        y += 12
        draw.line((0, y, width, y), fill='#202225', width=2)
        draw.text((18, y + 18), 'Pinned graphic and messages stay in place.', font=font(13), fill='#b9bbbe')
        image.crop((0, 0, width, y + 58)).save(out / f'{case["name"]}-{size}.png')
print('Rendered six desktop/mobile topic illustrations.')
